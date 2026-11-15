// SERVER-ONLY: the copy engine behind the Admin "switch master calendar" action.
//
// planCopy (pure) decides which events the app can read; runSwitch copies them from the current master
// into the candidate calendar (same event ids where Google accepts them, otherwise a deterministic new id with
// the old one kept in orig_id; source never modified), applies the moved/cancelled occurrences of copied
// recurring events, verifies the copy, then flips the settings pointer while holding the write lock. Google
// access goes through a small CalendarClient so the engine is testable with in-memory fakes.
//
// Never logs event content or tokens: events carry patient identifiers. Failures return fixed Thai text.
import { createHash } from "node:crypto";
import {
  isLockActive,
  promoteCandidate,
  withLock,
  withoutLock,
  type CalendarSettings,
  type CalendarTarget,
} from "./calendar-settings";
import type { CalendarSettingsStore } from "./calendar-settings-store";
import { calendarEventDate, parseLegacyCalendarEvent } from "./legacy-calendar";
import { normalizeEmail } from "./users";

export type GoogleEventLike = {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: { date?: string; dateTime?: string; timeZone?: string };
  reminders?: unknown;
  transparency?: string;
  visibility?: string;
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  created?: string;
  updated?: string;
  [key: string]: unknown;
};

export type CalendarClient = {
  // deadline: absolute ms (same clock as the run); the client stops paginating and times out pages there.
  // showDeleted: also list deleted entries (used only for the target's reads; never for the source).
  // expand: the app's own view instead (singleEvents=true: every occurrence, no masters, no cancelled
  // occurrences) over [timeMin, timeMax).
  // timeZone: render dateTimes in this zone (Google otherwise uses each calendar's own zone).
  listEvents(opts?: { deadline?: number; showDeleted?: boolean; expand?: ExpansionWindow; timeZone?: string }): Promise<GoogleEventLike[]>;
  upsertEvent(event: GoogleEventLike): Promise<"created" | "updated">;
  // One occurrence of a recurring event already in this calendar, addressed by its instance id
  // (`<masterId>_<original start>`, confirmed against real Google). update = events.update (PUT) with the
  // FULL occurrence: Google documents PUT for editing an occurrence, and PATCH was observed to inherit the
  // master's fields. An unknown occurrence throws an error with instanceMissing: true (404/410).
  // delete cancels it; "gone" = Google answered 404/410 (already cancelled, or no such occurrence).
  // DELETE on an occurrence is OBSERVED behaviour (not documented by Google); the final expanded gate in
  // runSwitch verifies what the app will really see.
  updateInstance(instanceId: string, body: GoogleEventLike): Promise<void>;
  deleteInstance(instanceId: string): Promise<"deleted" | "gone">;
  // The calendar's own time zone (events.list's top-level timeZone; calendars.get is not allowed with the
  // calendar.events scope), or null when Google does not send it.
  calendarTimeZone(opts?: { deadline?: number }): Promise<string | null>;
};

export const COPY_KINDS = ["booking", "extra_day", "schedule_closure", "staff_unavailable", "legacy"] as const;
export type CopyKind = (typeof COPY_KINDS)[number];
export type CopyCounts = Record<CopyKind, number>;
const TAGS: readonly string[] = ["booking", "extra_day", "schedule_closure", "staff_unavailable"];

// Fields written to the new calendar. Everything else (created/updated/etag/htmlLink/organizer/attendees/
// iCalUID ...) is server-owned or must not be sent: no attendee ever receives an invitation.
const COPY_FIELDS = [
  "id",
  "status",
  "summary",
  "description",
  "location",
  "colorId",
  "start",
  "end",
  "recurrence",
  "reminders",
  "transparency",
  "visibility",
  "extendedProperties",
] as const;

// Which kind the app reads this event as, or null when the app ignores it.
// - tagged with one of the app's four tags => that kind;
// - untagged and accepted by the legacy parser, or carrying a booking's queue_type (listUpcomingCalendarBookings
//   reads those through bookingFromEvent) => "legacy";
// - cancelled entries and recurring-exception instances (singleEvents=false returns them separately; their ids
//   contain "_" and cannot be inserted) => null.
export function classifyEvent(event: GoogleEventLike): CopyKind | null {
  if (event?.recurringEventId) return null;
  return readableKind(event);
}

// The app's readers on ONE event or occurrence (singleEvents=true returns occurrences with
// recurringEventId set): the four tags, bookingFromEvent (queue_type + date) and the legacy parser.
function readableKind(event: GoogleEventLike): CopyKind | null {
  if (!event || typeof event.id !== "string" || !event.id) return null;
  if (event.status === "cancelled") return null;
  const data = event.extendedProperties?.private;
  const tag = data?.or_queue;
  if (tag) return TAGS.includes(tag) ? (tag as CopyKind) : null;
  if (parseLegacyCalendarEvent(event)) return "legacy";
  if (data && (data.queue_type === "OR17" || data.queue_type === "EXTRA") && calendarEventDate(event)) return "legacy";
  return null;
}

// Fields written to one occurrence of a recurring event (an exception) with PUT: the full occurrence,
// including originalStartTime (recurringEventId is set to the master's target id). Never the occurrence's
// own id (it is in the URL) and never recurrence (instances have none).
const EXCEPTION_FIELDS = [
  "originalStartTime",
  "status",
  "summary",
  "description",
  "location",
  "colorId",
  "start",
  "end",
  "reminders",
  "transparency",
  "visibility",
  "extendedProperties",
] as const;

// Google sets created/updated itself on insert, so the originals travel as private orig_created /
// orig_updated (the readers in legacy-calendar.ts prefer them). A remapped event (its id was not accepted
// by Google) keeps its old id in orig_id. Values a source already carries win, so a later switch back keeps
// the first dates and the first id.
const ORIG_KEYS = ["orig_created", "orig_updated", "orig_id"] as const;

function copyBody(event: GoogleEventLike, fields: readonly string[], targetId?: string): GoogleEventLike {
  const out: GoogleEventLike = {};
  for (const key of fields) {
    if (event[key] !== undefined) out[key] = structuredClone(event[key]) as never;
  }
  const orig: Record<string, string> = {};
  const existing = event.extendedProperties?.private ?? {};
  if (targetId !== undefined) {
    out.id = targetId;
    if (targetId !== event.id && !existing.orig_id && typeof event.id === "string") orig.orig_id = event.id;
  }
  if (!existing.orig_created && typeof event.created === "string" && event.created) orig.orig_created = event.created;
  if (!existing.orig_updated && typeof event.updated === "string" && event.updated) orig.orig_updated = event.updated;
  if (Object.keys(orig).length) {
    const ext = out.extendedProperties ?? {};
    out.extendedProperties = { ...ext, private: { ...(ext.private ?? {}), ...orig } };
  }
  return out;
}

// Source events that are recurring masters or exception instances (reported by preview).
export function countRecurring(events: GoogleEventLike[]): number {
  return events.filter((e) => (Array.isArray(e.recurrence) && e.recurrence.length > 0) || !!e.recurringEventId).length;
}

const emptyCounts = (): CopyCounts => ({ booking: 0, extra_day: 0, schedule_closure: 0, staff_unavailable: 0, legacy: 0 });

// Google's insert-with-id accepts only base32hex ids. Events created elsewhere (CalDAV, Outlook, ICS
// import, hand-typed legacy events) may carry other ids; those are copied under a new id (remapEventId).
export const GOOGLE_EVENT_ID_PATTERN = /^[a-v0-9]{5,1024}$/;

// Deterministic replacement id: "oi" + the first 40 hex digits of sha256(source id). Every character is
// base32hex (o, i, 0-9, a-f), so Google accepts it; the same source id always maps to the same new id, so
// a re-run finds what an earlier press copied.
export function remapEventId(sourceId: string): string {
  return `oi${createHash("sha256").update(sourceId, "utf8").digest("hex").slice(0, 40)}`;
}

// The id an event gets in the target calendar: its own when Google accepts it, else the remapped one.
export function planTargetId(sourceId: string): string {
  return GOOGLE_EVENT_ID_PATTERN.test(sourceId) ? sourceId : remapEventId(sourceId);
}

// Plan refusals (decided before the lock; also checked by runSwitch before any write). Fixed Thai text.
export const ID_COLLISION_MESSAGE =
  "รหัส event ใหม่ที่ระบบออกให้ (สำหรับรายการที่ Google ไม่รับรหัสเดิม) ซ้ำกับรายการอื่น จึงยังไม่ได้เปลี่ยนปฏิทิน ห้ามแก้ไขหรือลบรายการใด ๆ ใน Google Calendar และติดต่อผู้พัฒนา";
export const REMAPPED_MASTER_EXCEPTION_MESSAGE =
  "มีรายการยกเว้นของรายการซ้ำ (recurring) ที่รายการต้นแบบต้องออกรหัส event ใหม่ ระบบยังคัดลอกกรณีนี้ไม่ได้ จึงยังไม่ได้เปลี่ยนปฏิทิน ห้ามแก้ไขหรือลบรายการใด ๆ ใน Google Calendar และติดต่อผู้พัฒนา";
export const EXCEPTION_INSTANCE_ID_MESSAGE =
  "มีรายการยกเว้นของรายการซ้ำ (recurring) ที่ระบบหาวันเดิมของรายการไม่ได้ จึงยังไม่ได้เปลี่ยนปฏิทิน ห้ามแก้ไขหรือลบรายการใด ๆ ใน Google Calendar และติดต่อผู้พัฒนา";
// A copy-step failure that pressing again cannot fix (Google does not know that occurrence in the new calendar).
export const EXCEPTION_APPLY_FAILED_MESSAGE =
  "ปฏิทินใหม่ไม่รับรายการยกเว้นของรายการซ้ำ (recurring) บางรายการ (ไม่พบวันนั้นในรายการซ้ำ) จึงยังไม่ได้เปลี่ยนปฏิทิน ห้ามแก้ไขหรือลบรายการใด ๆ ใน Google Calendar และติดต่อผู้พัฒนา";

// The `<original start>` part of an occurrence's instance id: taken from the source exception's own id
// (Google built it from the master id), else from originalStartTime (dateTime → UTC YYYYMMDDTHHMMSSZ,
// all-day date → YYYYMMDD). null = cannot be determined.
function instanceSuffix(exception: GoogleEventLike, masterSourceId: string): string | null {
  const id = exception.id as string;
  const prefix = `${masterSourceId}_`;
  if (id.startsWith(prefix)) {
    const rest = id.slice(prefix.length);
    if (/^[0-9A-Za-z]+$/.test(rest)) return rest;
  }
  const ost = exception.originalStartTime;
  if (ost && typeof ost.dateTime === "string") {
    const t = Date.parse(ost.dateTime);
    if (Number.isFinite(t)) return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
    return null;
  }
  if (ost && typeof ost.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ost.date)) return ost.date.replace(/-/g, "");
  return null;
}

const isMasterEvent = (e: GoogleEventLike | undefined) => !!e && Array.isArray(e.recurrence) && e.recurrence.length > 0;

// ---- the app's view (singleEvents=true) -------------------------------------------------------
// The app lists the calendar with singleEvents=true, so planning and the final check work on that view over
// a bounded window: 2000-01-01 … now + EXPANSION_DAYS_AHEAD. Bounded by the run deadline like every read.
export type ExpansionWindow = { timeMin: string; timeMax: string };
// The engine reads both calendars in the app's zone, so dates and wall-clock times compare like for like
// whatever zone each calendar is set to (the app's own reads in calendar.ts are unchanged).
export const APP_TIME_ZONE = "Asia/Bangkok";
// Expanded reads fetch only what planning and the final gate use (nextPageToken is required or pagination
// would silently stop after the first page). Plain reads stay full: they feed the copy bodies.
export const EXPANDED_LIST_FIELDS = "nextPageToken,items(id,status,summary,description,location,start,end,recurringEventId,originalStartTime,extendedProperties)";
export const EXPANSION_WINDOW_START = "2000-01-01T00:00:00.000Z";
export const EXPANSION_DAYS_AHEAD = 400;
// Wall-clock date (the window only needs today's date; deps.now() is a test clock for timing).
export function expansionWindow(at: number = Date.now()): ExpansionWindow {
  return { timeMin: EXPANSION_WINDOW_START, timeMax: new Date(at + EXPANSION_DAYS_AHEAD * 86_400_000).toISOString() };
}

// Ms of an occurrence's original start: originalStartTime, else the instance-id suffix. NaN = unknown.
function suffixTime(suffix: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(suffix);
  if (!m) return NaN;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}Z`);
}
function ownStartMs(event: GoogleEventLike): number {
  if (event.start?.dateTime) return Date.parse(event.start.dateTime);
  if (event.start?.date) return Date.parse(`${event.start.date}T00:00:00Z`);
  return NaN;
}
function originalStartMs(event: GoogleEventLike, suffix: string | null): number {
  const ost = event.originalStartTime;
  if (ost?.dateTime) return Date.parse(ost.dateTime);
  if (ost?.date) return Date.parse(`${ost.date}T00:00:00Z`);
  return suffix ? suffixTime(suffix) : NaN;
}
const inWindow = (ms: number, w: ExpansionWindow) => Number.isFinite(ms) && ms >= Date.parse(w.timeMin) && ms < Date.parse(w.timeMax);

// What the app shows of one readable occurrence (compared by the final gate; orig_* props aside).
type OccurrenceView = { start: GoogleEventLike["start"]; end: GoogleEventLike["end"]; summary: string; description: string; location: string; data: string };
function occurrenceView(e: GoogleEventLike): OccurrenceView {
  return { start: e.start, end: e.end, summary: e.summary ?? "", description: e.description ?? "", location: e.location ?? "", data: privateWithoutOrig(e) };
}
// Same instant AND same wall-clock date/time: the app takes a booking's date from dateTime.slice(0, 10)
// (calendarEventDate), so the same instant rendered in another zone is a different booking date. The
// engine reads both sides in APP_TIME_ZONE; this is the second line if a calendar renders otherwise.
export function sameAppView(a: OccurrenceView, b: OccurrenceView): boolean {
  const time = (x: GoogleEventLike["start"], y: GoogleEventLike["start"]) => {
    if (!x || !y) return !x && !y;
    if ((x.date ?? "") !== (y.date ?? "")) return false;
    if (!x.dateTime && !y.dateTime) return true;
    const tx = Date.parse(x.dateTime ?? "");
    if (!Number.isFinite(tx) || tx !== Date.parse(y.dateTime ?? "")) return false;
    return (x.dateTime ?? "").slice(0, 19) === (y.dateTime ?? "").slice(0, 19);
  };
  return time(a.start, b.start) && time(a.end, b.end) && a.summary === b.summary && a.description === b.description && a.location === b.location && a.data === b.data;
}
// Readable target occurrences keyed by their own (target) id.
function targetOccurrences(expanded: GoogleEventLike[]): Map<string, OccurrenceView> {
  const out = new Map<string, OccurrenceView>();
  for (const e of expanded) if (readableKind(e)) out.set(e.id as string, occurrenceView(e));
  return out;
}
// Both ways: every readable source occurrence (keyed by its target-mapped id) is in the target with the same
// view, and the target shows no other readable occurrence.
function sameOccurrences(source: Map<string, OccurrenceView>, target: Map<string, OccurrenceView>): boolean {
  if (source.size !== target.size) return false;
  for (const [key, view] of source) {
    const t = target.get(key);
    if (!t || !sameAppView(view, t)) return false;
  }
  return true;
}

// Read-only diagnostics of a plan: counts and MASKED id shapes only. Never any event text or a full id.
export type IdReasons = { uppercase: number; hyphen: number; underscore: number; tooShort: number; tooLong: number; otherChars: number };
export type PlanDiagnostics = {
  invalidIds: {
    reasons: IdReasons;
    shapes: { shape: string; count: number }[];
    // invalid ids not covered by the listed shapes (invalidIds - sum of listed counts)
    shapesOmitted: number;
    byKind: { app: number; legacy: number; recurringMasters: number };
  };
  recurring: {
    masters: number;
    exceptionInstances: number;
    mastersPlanned: number;
    infiniteMasters: number;
    byFreq: { DAILY: number; WEEKLY: number; MONTHLY: number; YEARLY: number; other: number };
    exceptionsCancelled: number;
    // planned masters whose recurrence has EXDATE / RDATE / EXRULE lines
    rruleExtras: number;
  };
  skippedReasons: { cancelled: number; recurringException: number; notReadable: number };
  // exception items of planned masters that the copy will apply
  exceptions: { modify: number; cancel: number };
  // readable occurrences of the app's view that the plan does not cover (must be 0: refused otherwise)
  uncoveredOccurrences: number;
  // modified exceptions that are not an occurrence of the source's view (the app cannot show them): not applied
  orphanedExceptions: number;
};

const MAX_SHAPES = 5;
const MAX_SHAPE_LENGTH = 48;

// Run-length shape of an id; the output is ASCII only and never carries a character of the id itself.
// Rules, applied per code point (an emoji is ONE code point):
// - A-Z, a-z, 0-9 form "alphanumeric segments" between separators. Inside a segment, a run of lowercase
//   letters is `l<n>` and a run of uppercase letters is `U<n>`; a digit joins the run before it, a case
//   change starts a new run, and leading digits join the first letter run after them. A segment of only
//   digits takes the id-wide class: `U<n>` when the whole id has uppercase letters and no lowercase ones,
//   else `l<n>` (so a random uppercase UUID is always U8-U4-U4-U4-U12).
// - ASCII punctuation in the allowlist - _ . : @ / + = is kept as is (it separates segments).
// - Every other code point (non-ASCII letters, emoji, whitespace, control characters, other punctuation)
//   becomes `?`, and a run of them is `?<n>`.
// - Truncation happens AFTER masking, by code points, so a surrogate pair is never split.
const SHAPE_PUNCT = "-_.:@/+=";

function segmentShape(segment: string, digitClass: "l" | "U"): string {
  const chars = Array.from(segment);
  const caseOf = (c: string): "l" | "U" | null => (/[a-z]/.test(c) ? "l" : /[A-Z]/.test(c) ? "U" : null);
  const firstLetter = chars.map(caseOf).find((c) => c !== null) ?? digitClass;
  let out = "";
  let current = firstLetter;
  let length = 0;
  for (const c of chars) {
    const k = caseOf(c) ?? current;
    if (k !== current) {
      out += `${current}${length}`;
      current = k;
      length = 0;
    }
    length += 1;
  }
  return out + `${current}${length}`;
}

export function maskIdShape(id: string): string {
  let out = "";
  let segment = "";
  let unknown = 0;
  const digitClass = /[A-Z]/.test(id) && !/[a-z]/.test(id) ? "U" : "l";
  const flushSegment = () => {
    if (segment) out += segmentShape(segment, digitClass);
    segment = "";
  };
  const flushUnknown = () => {
    if (unknown) out += `?${unknown}`;
    unknown = 0;
  };
  for (const c of id) {
    if (/^[A-Za-z0-9]$/.test(c)) {
      flushUnknown();
      segment += c;
    } else if (c.length === 1 && SHAPE_PUNCT.includes(c)) {
      flushUnknown();
      flushSegment();
      out += c;
    } else {
      flushSegment();
      unknown += 1;
    }
  }
  flushSegment();
  flushUnknown();
  const points = Array.from(out);
  return points.length > MAX_SHAPE_LENGTH ? `${points.slice(0, MAX_SHAPE_LENGTH).join("")}…` : out;
}

function rrules(event: GoogleEventLike): string[] {
  return (Array.isArray(event.recurrence) ? event.recurrence : []).filter((r) => typeof r === "string" && /^RRULE:/i.test(r));
}

// One occurrence of a planned recurring master, written after the masters are copied. `id` is the
// occurrence's instance id in the TARGET (`<master target id>_<original start>`), masterId the master's
// target id; body (modify only) holds EXCEPTION_FIELDS.
export type ExceptionItem = { kind: "modify" | "cancel"; id: string; masterId: string; body?: GoogleEventLike };

// copy: bodies to write, each `id` already the TARGET id (remapped when Google rejects the source id).
// invalidIds: planned (copied) events whose id GOOGLE_EVENT_ID_PATTERN rejects (they are remapped); skipped
// events never count. refusal: fixed Thai text when the plan must not run (else null); planCopy never throws.
export type CopyPlan = {
  copy: GoogleEventLike[];
  skipped: number;
  counts: CopyCounts;
  byMonth: Record<string, number>;
  invalidIds: number;
  exceptions: ExceptionItem[];
  refusal: string | null;
  uncoveredOccurrences: number;
  // Only when the app's view was given: readable occurrences keyed by their TARGET-mapped id, and the
  // mapped ids of every occurrence of a planned master in the view (readable or not).
  occurrences: Map<string, OccurrenceView> | null;
  occurrenceKeys: Set<string> | null;
  window: ExpansionWindow;
  diagnostics: PlanDiagnostics;
};

// After the switch the app reads the new calendar WITHOUT a timeZone parameter, i.e. in that calendar's own
// zone, and takes booking dates from dateTime.slice(0, 10): the new calendar must be in APP_TIME_ZONE.
export const TARGET_TIME_ZONE_MESSAGE =
  "ปฏิทินใหม่ไม่ได้ตั้ง time zone เป็น (GMT+07:00) Bangkok จึงยังไม่ได้เปลี่ยนปฏิทิน ให้เปิด Google Calendar → Settings → เลือกปฏิทินใหม่ → Time zone แล้วตั้งเป็น (GMT+07:00) Bangkok จากนั้นกดตรวจตัวอย่างใหม่";
export const TARGET_TIME_ZONE_UNKNOWN_MESSAGE =
  "อ่าน time zone ของปฏิทินใหม่ไม่ได้ (Google ไม่ส่งค่ามา) จึงยังไม่ได้เปลี่ยนปฏิทิน ตรวจว่าปฏิทินใหม่ตั้ง time zone เป็น (GMT+07:00) Bangkok แล้วกดตรวจตัวอย่างใหม่ ถ้ายังขึ้นข้อความนี้ให้ติดต่อผู้พัฒนา";

export const UNCOVERED_OCCURRENCES_MESSAGE =
  "ปฏิทินหลักปัจจุบันมีรายการที่แอปแสดงอยู่แต่ไม่อยู่ในแผนคัดลอก จึงยังไม่ได้เปลี่ยนปฏิทิน ให้หยุดตรงนี้ ห้ามแก้ไขหรือลบรายการใด ๆ ใน Google Calendar และติดต่อผู้พัฒนา";

// expanded = the source's app view (singleEvents=true over `window`). With it, a recurring master is planned
// when the master OR any of its occurrences is readable, modified exceptions that are not occurrences of the
// view are orphans (not applied), and readable occurrences the plan does not cover refuse the plan.
// Without it (the target's conflict check, older callers) masters are judged by themselves only.
export function planCopy(source: GoogleEventLike[], expanded?: GoogleEventLike[], viewWindow: ExpansionWindow = expansionWindow()): CopyPlan {
  const copy: GoogleEventLike[] = [];
  const counts = emptyCounts();
  const byMonth: Record<string, number> = {};
  const seen = new Set<string>();
  let skipped = 0;
  let invalidIds = 0;
  const reasons: IdReasons = { uppercase: 0, hyphen: 0, underscore: 0, tooShort: 0, tooLong: 0, otherChars: 0 };
  const shapeCounts = new Map<string, number>();
  const byKind = { app: 0, legacy: 0, recurringMasters: 0 };
  const recurring: PlanDiagnostics["recurring"] = {
    masters: 0,
    exceptionInstances: 0,
    mastersPlanned: 0,
    infiniteMasters: 0,
    byFreq: { DAILY: 0, WEEKLY: 0, MONTHLY: 0, YEARLY: 0, other: 0 },
    exceptionsCancelled: 0,
    rruleExtras: 0,
  };
  // kind of the EARLIEST readable occurrence of each master in the app's view (by SOURCE master id; ties by
  // id), so the plan does not depend on the order Google lists occurrences in
  const occurrenceKind = new Map<string, CopyKind>();
  const occurrenceRank = new Map<string, [number, string]>();
  const viewIds = new Set<string>();
  for (const occ of expanded ?? []) {
    if (!occ || typeof occ.id !== "string") continue;
    viewIds.add(occ.id);
    const k = readableKind(occ);
    if (!k || typeof occ.recurringEventId !== "string") continue;
    const at = ownStartMs(occ);
    const rank: [number, string] = [Number.isFinite(at) ? at : Infinity, occ.id];
    const best = occurrenceRank.get(occ.recurringEventId);
    if (!best || rank[0] < best[0] || (rank[0] === best[0] && rank[1] < best[1])) {
      occurrenceRank.set(occ.recurringEventId, rank);
      occurrenceKind.set(occ.recurringEventId, k);
    }
  }
  const skippedReasons = { cancelled: 0, recurringException: 0, notReadable: 0 };
  const skip = (event: GoogleEventLike | undefined) => {
    skipped += 1;
    if (event?.status === "cancelled") skippedReasons.cancelled += 1;
    else if (event?.recurringEventId) skippedReasons.recurringException += 1;
    else skippedReasons.notReadable += 1;
  };
  let refusal: string | null = null;
  const refuse = (message: string) => {
    refusal ??= message;
  };
  // target id -> the source id that claimed it (two different source ids on one target id = collision)
  const owners = new Map<string, string>();
  const claim = (targetId: string, sourceId: string) => {
    const owner = owners.get(targetId);
    if (owner !== undefined && owner !== sourceId) refuse(ID_COLLISION_MESSAGE);
    owners.set(targetId, sourceId);
  };
  // planned recurring masters by SOURCE id; exceptions wait until every master is known (any order)
  const plannedMasters = new Map<string, { targetId: string; remapped: boolean }>();
  const pending: GoogleEventLike[] = [];
  for (const event of source) {
    const isMaster = !!event && Array.isArray(event.recurrence) && event.recurrence.length > 0;
    if (isMaster) {
      recurring.masters += 1;
      const rules = rrules(event);
      const freq = /(?:^|[;:])FREQ=([A-Za-z]+)/i.exec(rules[0] ?? "")?.[1]?.toUpperCase();
      const key = freq === "DAILY" || freq === "WEEKLY" || freq === "MONTHLY" || freq === "YEARLY" ? freq : "other";
      recurring.byFreq[key] += 1;
      if (rules.length > 0 && rules.every((r) => !/(?:^|[;:])(UNTIL|COUNT)=/i.test(r))) recurring.infiniteMasters += 1;
    }
    if (event?.recurringEventId) {
      recurring.exceptionInstances += 1;
      if (event.status === "cancelled") recurring.exceptionsCancelled += 1;
    }
    if (event?.recurringEventId && typeof event.id === "string" && event.id) {
      pending.push(event);
      continue;
    }
    const kind = classifyEvent(event) ?? (isMaster ? occurrenceKind.get(event.id as string) ?? null : null);
    if (!kind || seen.has(event.id as string)) {
      skip(event);
      continue;
    }
    const id = event.id as string;
    seen.add(id);
    const targetId = planTargetId(id);
    claim(targetId, id);
    if (isMaster) {
      recurring.mastersPlanned += 1;
      plannedMasters.set(id, { targetId, remapped: targetId !== id });
      if ((event.recurrence ?? []).some((r) => typeof r === "string" && /^(EXDATE|RDATE|EXRULE)[;:]/i.test(r))) recurring.rruleExtras += 1;
    }
    if (targetId !== id) {
      invalidIds += 1;
      if (/[A-Z]/.test(id)) reasons.uppercase += 1;
      if (id.includes("-")) reasons.hyphen += 1;
      if (id.includes("_")) reasons.underscore += 1;
      if (id.length < 5) reasons.tooShort += 1;
      if (id.length > 1024) reasons.tooLong += 1;
      if (/[^a-v0-9A-Z_-]/.test(id)) reasons.otherChars += 1;
      const shape = maskIdShape(id);
      shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1);
      if (kind === "legacy") byKind.legacy += 1;
      else byKind.app += 1;
      if (isMaster) byKind.recurringMasters += 1;
    }
    copy.push(copyBody(event, COPY_FIELDS, targetId));
    counts[kind] += 1;
    const month = calendarEventDate(event).slice(0, 7) || "unknown";
    byMonth[month] = (byMonth[month] ?? 0) + 1;
  }
  // Exceptions of planned masters become items; the rest stay skipped (by their old reason).
  const exceptions: ExceptionItem[] = [];
  const exceptionCounts = { modify: 0, cancel: 0 };
  let orphanedExceptions = 0;
  let uncoveredOccurrences = 0;
  const seenExceptions = new Set<string>();
  for (const event of pending) {
    const sourceId = event.id as string;
    const masterSourceId = event.recurringEventId as string;
    const master = plannedMasters.get(masterSourceId);
    if (!master || seenExceptions.has(sourceId)) {
      // An exception the app would read, moved outside the window, of a master that is not copied: the view
      // cannot show it, so it is not covered (inside the window it would have planned its master).
      if (expanded && !master && readableKind(event) && !inWindow(ownStartMs(event), viewWindow)) uncoveredOccurrences += 1;
      skip(event);
      continue;
    }
    seenExceptions.add(sourceId);
    // The occurrence would have to be addressed under the master's NEW id: never guess, refuse.
    if (master.remapped) {
      refuse(REMAPPED_MASTER_EXCEPTION_MESSAGE);
      continue;
    }
    const suffix = instanceSuffix(event, masterSourceId);
    if (!suffix) {
      refuse(EXCEPTION_INSTANCE_ID_MESSAGE);
      continue;
    }
    const id = `${master.targetId}_${suffix}`;
    // A modified exception that is not an occurrence of the app's view (its original start is no longer an
    // occurrence of the rule) cannot be shown by the app: not applied, counted. Google filters the view by
    // each occurrence's OWN start, so this is decided only when BOTH its original start and its own start
    // are inside the window; otherwise it is applied as usual (and verified per item). Cancels are always
    // applied (404/410 = satisfied).
    if (
      expanded &&
      event.status !== "cancelled" &&
      !viewIds.has(sourceId) &&
      inWindow(originalStartMs(event, suffix), viewWindow) &&
      inWindow(ownStartMs(event), viewWindow)
    ) {
      orphanedExceptions += 1;
      continue;
    }
    claim(id, sourceId);
    if (event.status === "cancelled") {
      exceptions.push({ kind: "cancel", id, masterId: master.targetId });
      exceptionCounts.cancel += 1;
    } else {
      const body = copyBody(event, EXCEPTION_FIELDS);
      body.recurringEventId = master.targetId;
      exceptions.push({ kind: "modify", id, masterId: master.targetId, body });
      exceptionCounts.modify += 1;
    }
  }
  // The app's view: map every occurrence to its target id; readable ones must be covered by the plan.
  let occurrences: Map<string, OccurrenceView> | null = null;
  let occurrenceKeys: Set<string> | null = null;
  if (expanded) {
    occurrences = new Map();
    occurrenceKeys = new Set();
    for (const occ of expanded) {
      if (!occ || typeof occ.id !== "string" || !occ.id) continue;
      const readable = readableKind(occ) !== null;
      let key: string | null = null;
      let covered = false;
      if (typeof occ.recurringEventId === "string") {
        const master = plannedMasters.get(occ.recurringEventId);
        const suffix = instanceSuffix(occ, occ.recurringEventId);
        if (master && suffix) {
          key = `${master.targetId}_${suffix}`;
          covered = true;
          occurrenceKeys.add(key);
        }
      } else if (seen.has(occ.id)) {
        key = planTargetId(occ.id);
        covered = true;
      }
      if (!readable) continue;
      if (!covered || key === null) uncoveredOccurrences += 1;
      else occurrences.set(key, occurrenceView(occ));
    }
  }
  if (uncoveredOccurrences > 0) refuse(UNCOVERED_OCCURRENCES_MESSAGE);
  const shapes = [...shapeCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_SHAPES)
    .map(([shape, count]) => ({ shape, count }));
  const shapesOmitted = invalidIds - shapes.reduce((n, x) => n + x.count, 0);
  return {
    copy,
    skipped,
    counts,
    byMonth,
    invalidIds,
    exceptions,
    refusal,
    uncoveredOccurrences,
    occurrences,
    occurrenceKeys,
    window: viewWindow,
    diagnostics: {
      invalidIds: { reasons, shapes, shapesOmitted, byKind },
      recurring,
      skippedReasons,
      exceptions: exceptionCounts,
      uncoveredOccurrences,
      orphanedExceptions,
    },
  };
}

// Entries in the target that the plan does not account for (all compared by TARGET id):
// - app events the source no longer has (the app hard-deletes events, so an old populated master still
//   holds them; switching there would resurrect them);
// - occurrences (exceptions) of a planned master that the source does not have (they would move or hide an
//   occurrence the source shows). A CANCELLED one is harmless when the source's view does not show that
//   occurrence either (e.g. an EXDATE), which is known only inside the window. Exceptions of masters the
//   app does not copy are ignored.
function targetConflictCount(plan: CopyPlan, targetEvents: GoogleEventLike[]): number {
  const planIds = new Set(plan.copy.map((e) => e.id as string));
  const masterIds = new Set(plan.copy.filter(isMasterEvent).map((e) => e.id as string));
  const exceptionIds = new Set(plan.exceptions.map((x) => x.id));
  let conflicts = planCopy(targetEvents).copy.filter((e) => !planIds.has(e.id as string)).length;
  for (const e of targetEvents) {
    if (!e || typeof e.id !== "string" || typeof e.recurringEventId !== "string") continue;
    if (!masterIds.has(e.recurringEventId) || exceptionIds.has(e.id)) continue;
    const suffix = e.id.startsWith(`${e.recurringEventId}_`) ? e.id.slice(e.recurringEventId.length + 1) : null;
    const hiddenInSource = e.status === "cancelled" && !!plan.occurrenceKeys && !plan.occurrenceKeys.has(e.id) && inWindow(originalStartMs(e, suffix), plan.window);
    if (!hiddenInSource) conflicts += 1;
  }
  return conflicts;
}

// What a switch decides BEFORE taking the lock (and preview shows). Refusals: targetConflicts > 0 (only a
// calendar without such entries can be the target) and a plan refusal. invalidIds (remapped ids) and
// exceptions are informational.
// expanded = the source's app view (singleEvents=true over `window`), read without writes.
// targetTimeZone = the target calendar's own zone (null = Google sent none; undefined = not checked). A zone
// other than APP_TIME_ZONE, or none, is refused; that refusal wins (the admin can fix it in the settings).
export function switchPreflight(
  sourceEvents: GoogleEventLike[],
  targetEvents: GoogleEventLike[],
  expanded?: GoogleEventLike[],
  viewWindow: ExpansionWindow = expansionWindow(),
  targetTimeZone?: string | null,
): {
  targetConflicts: number;
  invalidIds: number;
  exceptions: { modify: number; cancel: number };
  uncoveredOccurrences: number;
  orphanedExceptions: number;
  refusal: string | null;
} {
  const plan = planCopy(sourceEvents, expanded, viewWindow);
  const out = {
    targetConflicts: targetConflictCount(plan, targetEvents),
    invalidIds: plan.invalidIds,
    exceptions: { ...plan.diagnostics.exceptions },
    uncoveredOccurrences: plan.uncoveredOccurrences,
    orphanedExceptions: plan.diagnostics.orphanedExceptions,
    refusal:
      targetTimeZone === undefined || targetTimeZone === APP_TIME_ZONE
        ? plan.refusal
        : targetTimeZone === null
          ? TARGET_TIME_ZONE_UNKNOWN_MESSAGE
          : TARGET_TIME_ZONE_MESSAGE,
  };
  return out;
}

// ---- token-only refresh ------------------------------------------------------------
type CalendarRef = { email: string; calendarId: string };

// Google accepts the alias "primary" for an account's own calendar, and calendar ids are email-like, so
// "primary" resolves to the owner's email and ids compare case-insensitively.
export function resolveCalendarId(ref: CalendarRef): string {
  const id = ref.calendarId.trim().toLowerCase();
  return id === "primary" ? normalizeEmail(ref.email) : id;
}

// Same underlying calendar, whichever account reaches it.
export function sameCalendarId(a: CalendarRef, b: CalendarRef) {
  return resolveCalendarId(a) === resolveCalendarId(b);
}

// Same account AND same calendar: the token-only renewal case.
export function isSameCalendar(a: CalendarRef, b: CalendarRef) {
  return normalizeEmail(a.email) === normalizeEmail(b.email) && sameCalendarId(a, b);
}

// Renewal for the same account + calendar: no copy. Settings mode keeps master's place and previousMaster
// and only swaps the sealed token; env mode makes the candidate the settings master (previousMaster = env).
export function withRefreshedMasterToken(settings: CalendarSettings, envMaster?: CalendarTarget): CalendarSettings {
  const candidate = settings.candidate;
  if (!candidate) throw new Error("no candidate calendar");
  const current = settings.master ?? envMaster;
  if (current && !isSameCalendar(candidate, current)) throw new Error("candidate is not the master calendar");
  if (settings.master) {
    const out: CalendarSettings = { master: { ...settings.master, sealedRefreshToken: candidate.sealedRefreshToken } };
    if (settings.previousMaster) out.previousMaster = settings.previousMaster;
    return out;
  }
  return promoteCandidate(settings, envMaster);
}

// ---- runSwitch ------------------------------------------------------------------------
// "preflight" = refused before any lock was taken (nothing written).
export type SwitchStep = "preflight" | "lock" | "read" | "copy" | "verify" | "flip";

// Each message is used only when the stated outcome is confirmed (a failure before the flip, or a flip
// whose read-back shows the master unchanged).
export const SWITCH_STEP_MESSAGES: Record<SwitchStep, string> = {
  preflight: "ตรวจปฏิทินก่อนสลับไม่สำเร็จ ยังไม่ได้เปลี่ยนปฏิทิน กรุณาลองใหม่",
  lock: "เริ่มการเปลี่ยนปฏิทินไม่สำเร็จ (ล็อกการแก้ไขไม่ได้) ยังไม่ได้เปลี่ยนปฏิทิน",
  read: "อ่านข้อมูลจากปฏิทินหลักปัจจุบันไม่สำเร็จ ยังไม่ได้เปลี่ยนปฏิทิน",
  copy: "คัดลอกข้อมูลไปปฏิทินใหม่ไม่สำเร็จ ยังไม่ได้เปลี่ยนปฏิทิน กดเปลี่ยนอีกครั้งเพื่อคัดลอกต่อได้",
  verify: "ตรวจข้อมูลในปฏิทินใหม่แล้วไม่ตรงกับปฏิทินหลัก ยังไม่ได้เปลี่ยนปฏิทิน",
  flip: "บันทึกการเปลี่ยนปฏิทินหลักไม่สำเร็จ ยังไม่ได้เปลี่ยนปฏิทิน",
};
// Preflight refusals (decided before the lock; also the engine's second line for target conflicts).
export const TARGET_CONFLICTS_MESSAGE =
  "ปฏิทินปลายทางมีรายการของแอปที่ปฏิทินหลักปัจจุบันไม่มีแล้ว (ถูกยกเลิกหรือลบไปหลังเคยคัดลอก) ถ้าสลับไป รายการเหล่านั้นจะกลับมาในแอป จึงยังไม่ได้เปลี่ยนปฏิทิน วิธีที่ปลอดภัยคือสร้างปฏิทินใหม่ที่ว่าง แล้วเชื่อมต่อและสลับไปปฏิทินนั้นแทน";
export const PREFLIGHT_TARGET_FAILED_MESSAGE = "อ่านข้อมูลจากปฏิทินใหม่ไม่สำเร็จ ยังไม่ได้เปลี่ยนปฏิทิน กรุณาลองใหม่";
// The preflight (before the lock) already used the whole copy budget of this request.
export const PREFLIGHT_SLOW_MESSAGE = "ตรวจปฏิทินก่อนสลับใช้เวลานานเกินไป ยังไม่ได้เปลี่ยนปฏิทิน กรุณาลองใหม่";

// The flip write failed and its outcome could not be read back.
export const SWITCH_OUTCOME_UNKNOWN_MESSAGE = "ไม่ทราบผลการเปลี่ยนปฏิทินหลัก กรุณาเปิดหน้าสถานะเพื่อตรวจก่อนทำรายการต่อ";

// GET reads may serve settings cached for up to 30 s; the lock stays on this long after the flip so every
// instance has re-read the new master before writes resume.
export const LOCK_HOLD_AFTER_FLIP_MS = 35_000;
// The lock is renewed during a long copy so its 20 min TTL never lapses mid-copy.
export const LOCK_RENEW_MS = 5 * 60_000;
// A write that passed the lock check just before the lock was set is aborted by the app within
// CALENDAR_WRITE_DEADLINE_MS (30 s, calendar-target.ts); the second source read waits this long after the
// confirmed lock so such a write has landed (or never will) before the last copy pass.
// Must stay larger than CALENDAR_WRITE_DEADLINE_MS (30 s) plus the time Google may take to resolve a write
// already sent at the abort, which is also the window createBookingEvent's lookup GET relies on.
export const SETTLE_MS = 45_000;
export const COPY_CONCURRENCY = 5;
// A settings put can be aborted (5 s) and still commit a moment later. After a storage error on a lock
// or flip write the run waits this long before trusting a read-back of the file.
export const SETTINGS_SETTLE_MS = 8_000;
// Copy-phase budget inside one request (route maxDuration = 300 s): checked before each upsert, before
// the settle wait and before the flip; the remaining hold + release fit in what is left.
export const COPY_PHASE_BUDGET_MS = 150_000;
// Hard deadline from the run start for everything up to the flip (reads, verify, delta). Worst case after
// the flip ≈ flip 23 s + hold 35 s + release 28 s ≈ 86 s, so a run stays under maxDuration 300 s.
export const RUN_HARD_DEADLINE_MS = 170_000;
export const COPY_BUDGET_MESSAGE = "คัดลอกยังไม่เสร็จในรอบเวลานี้ ยังไม่ได้เปลี่ยนปฏิทิน กดเปลี่ยนอีกครั้งเพื่อคัดลอกส่วนที่เหลือต่อ";

export type SwitchDeps = {
  settings: CalendarSettingsStore;
  source: CalendarClient;
  target: CalendarClient;
  by: string;
  now: () => number;
  // The candidate the target client was built for, and the settings master the source client was built
  // for (undefined = env master). The run refuses if the file no longer holds exactly these.
  candidate: CalendarTarget;
  master?: CalendarTarget;
  // Sealed env master; passed only when the file has no master, so it becomes previousMaster.
  envMaster?: CalendarTarget;
  sleep?: (ms: number) => Promise<void>;
  // When the request started (the handler's preflight runs before runSwitch): the copy budget and the hard
  // deadline count from here, so preflight + run stay inside the route's maxDuration. Default: now().
  runStart?: number;
  // Tests only; production uses expansionWindow() at the run start.
  window?: ExpansionWindow;
  // Tests only; production uses COPY_PHASE_BUDGET_MS.
  copyBudgetMs?: number;
  hardDeadlineMs?: number;
};

export type SwitchResult =
  | {
      ok: true;
      copied: number;
      created: number;
      updated: number;
      // already in the target exactly as in the source (re-run): not sent again
      unchanged: number;
      counts: CopyCounts;
      skipped: number;
      // exception items of the final plan, how many were written this press, how many already matched
      exceptions: { modify: number; cancel: number; applied: number; unchanged: number };
      lockCleared: boolean;
    }
  | { ok: false; step: SwitchStep; error: string };

class StepError extends Error {
  readonly step: SwitchStep;
  readonly failure: unknown;
  readonly unknownOutcome: boolean;
  readonly userMessage: string | undefined;
  constructor(step: SwitchStep, failure?: unknown, unknownOutcome = false, userMessage?: string) {
    super(step);
    this.step = step;
    this.failure = failure;
    this.unknownOutcome = unknownOutcome;
    this.userMessage = userMessage;
  }
}

export function sameCalendarTarget(a: CalendarTarget | undefined, b: CalendarTarget | undefined) {
  if (!a || !b) return !a && !b;
  return a.email === b.email && a.calendarId === b.calendarId && a.sealedRefreshToken === b.sealedRefreshToken;
}
const sameTarget = sameCalendarTarget;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- verify helpers (order-insensitive; never compare Google-owned fields) ----
function privateWithoutOrig(event: GoogleEventLike): string {
  const p = event.extendedProperties?.private ?? {};
  const keys = Object.keys(p).filter((k) => !(ORIG_KEYS as readonly string[]).includes(k)).sort();
  return JSON.stringify(keys.map((k) => [k, p[k]]));
}

function sameTime(a: GoogleEventLike["start"], b: GoogleEventLike["start"]): boolean {
  if (!a || !b) return !a && !b;
  if ((a.date ?? "") !== (b.date ?? "")) return false;
  if (a.dateTime || b.dateTime) {
    // The target calendar may render the same instant in its own offset.
    const ta = Date.parse(a.dateTime ?? "");
    const tb = Date.parse(b.dateTime ?? "");
    if (!Number.isFinite(ta) || ta !== tb) return false;
  }
  // A time zone the source carried must survive (it drives recurring events).
  return !a.timeZone || a.timeZone === b.timeZone;
}

// Verify's comparator: private props (orig_* aside), start and end.
function sameCore(target: GoogleEventLike, source: GoogleEventLike): boolean {
  return privateWithoutOrig(target) === privateWithoutOrig(source) && sameTime(source.start, target.start) && sameTime(source.end, target.end);
}

// Re-run skip test: verify's comparator PLUS every other copied content field, so an event is skipped only
// when nothing the copy would send differs (stricter than verify on purpose: a false "match" would lose data,
// a false "mismatch" only costs one upsert). Legacy events keep their data in the summary.
const CONTENT_FIELDS = ["status", "summary", "description", "location", "colorId", "recurrence", "reminders", "transparency", "visibility"] as const;
function targetMatchesSource(target: GoogleEventLike | undefined, source: GoogleEventLike): boolean {
  if (!target || !sameCore(target, source)) return false;
  return CONTENT_FIELDS.every((k) => JSON.stringify(target[k]) === JSON.stringify(source[k]));
}

// Re-run skip test for one occurrence: a cancel is done when the target lists it cancelled; a modify when
// the target lists it (not cancelled) with every field the patch would send.
const EXCEPTION_CONTENT_FIELDS = ["status", "summary", "description", "location", "colorId", "reminders", "transparency", "visibility"] as const;
function exceptionMatches(target: GoogleEventLike | undefined, item: ExceptionItem): boolean {
  if (!target) return false;
  if (item.kind === "cancel") return target.status === "cancelled";
  if (target.status === "cancelled" || !item.body || !sameCore(target, item.body)) return false;
  return EXCEPTION_CONTENT_FIELDS.every((k) => JSON.stringify(target[k]) === JSON.stringify(item.body?.[k]));
}

// Verify's comparator for one modified occurrence: present, not cancelled, with the source's private
// props, start, end, summary, description and location. (Cancels are checked in verifyTarget.)
function exceptionVerified(target: GoogleEventLike | undefined, item: ExceptionItem): boolean {
  if (!target || !item.body || target.status === "cancelled" || !sameCore(target, item.body)) return false;
  return (["summary", "description", "location"] as const).every((k) => (target[k] ?? "") === (item.body?.[k] ?? ""));
}

function samePlans(a: CopyPlan, b: CopyPlan): boolean {
  if (a.refusal !== b.refusal) return false;
  if (a.occurrences && b.occurrences) {
    if (!sameOccurrences(a.occurrences, b.occurrences)) return false;
  } else if (a.occurrences || b.occurrences) {
    return false;
  }
  if (a.copy.length !== b.copy.length || a.exceptions.length !== b.exceptions.length) return false;
  const bodies = new Map(a.copy.map((e) => [e.id as string, JSON.stringify(e)]));
  if (!b.copy.every((e) => bodies.get(e.id as string) === JSON.stringify(e))) return false;
  const items = new Map(a.exceptions.map((x) => [x.id, JSON.stringify(x)]));
  return b.exceptions.every((x) => items.get(x.id) === JSON.stringify(x));
}

export async function runSwitch(deps: SwitchDeps): Promise<SwitchResult> {
  const sleep = deps.sleep ?? defaultSleep;
  // Defense in depth: copying a calendar onto itself would rewrite every live event (PUT replaces the
  // whole event). Refuse before taking the lock; the source is never modified.
  const sourceRef = deps.master ?? deps.envMaster;
  if (sourceRef && sameCalendarId(deps.candidate, sourceRef)) {
    return { ok: false, step: "lock", error: SWITCH_STEP_MESSAGES.lock };
  }

  // Every lock `since` this run has written or tried to write. A Blob put can commit and still report
  // an error (timeout after landing), so "ours" is any of them, not only the last confirmed one.
  const mine = new Set<number>();
  let lockSince: number | null = null;
  let lockTakenAt = 0;
  const runStart = deps.runStart ?? deps.now();
  const budget = deps.copyBudgetMs ?? COPY_PHASE_BUDGET_MS;
  const overBudget = () => deps.now() - runStart > budget;
  const budgetError = () => new StepError("copy", new Error("copy budget exceeded"), false, COPY_BUDGET_MESSAGE);
  const checkBudget = () => {
    if (overBudget()) throw budgetError();
  };
  const hardDeadline = runStart + (deps.hardDeadlineMs ?? RUN_HARD_DEADLINE_MS);
  const pastHard = () => deps.now() > hardDeadline;
  const checkHard = () => {
    if (pastHard()) throw budgetError();
  };
  // Every list call carries the hard deadline; a deadline breach (by the client or by the clock after the
  // call) aborts as a resumable "copy" failure, any other error keeps its own step.
  const viewWindow = deps.window ?? expansionWindow();
  async function listBounded(step: SwitchStep, client: CalendarClient, view: "plain" | "deleted" | "expand" = "plain"): Promise<GoogleEventLike[]> {
    let events: GoogleEventLike[];
    const base = { deadline: hardDeadline, timeZone: APP_TIME_ZONE };
    const opts = view === "deleted" ? { ...base, showDeleted: true } : view === "expand" ? { ...base, expand: viewWindow } : base;
    try {
      events = await client.listEvents(opts);
    } catch (err) {
      if ((err as { deadlineExceeded?: unknown } | null)?.deadlineExceeded === true || pastHard()) throw budgetError();
      throw new StepError(step, err);
    }
    checkHard();
    return events;
  }
  const ours = (s: CalendarSettings | "missing"): s is CalendarSettings =>
    s !== "missing" && !!s.lock && s.lock.by === deps.by && mine.has(s.lock.since);

  async function stepRun<T>(step: SwitchStep, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw err instanceof StepError ? err : new StepError(step, err);
    }
  }

  // One lock-carrying settings write. On an error, re-read the file: if it holds exactly what we tried to
  // write (`landed`), the write committed and the run goes on. A failed re-read rethrows as unknown.
  async function lockWrite(
    since: number,
    fn: (s: CalendarSettings | "missing") => CalendarSettings,
    landed: (s: CalendarSettings | "missing") => boolean,
  ): Promise<void> {
    mine.add(since);
    let attempted = false; // fn returned a value, so a put may have been sent
    try {
      await deps.settings.mutate((s) => {
        const next = fn(s); // a refusal thrown here is not a storage error: no write, no settle
        attempted = true;
        return next;
      });
    } catch (err) {
      if (!attempted) throw err;
      // Storage error: the put may still commit after its abort. Wait, then trust the read-back.
      await sleep(SETTINGS_SETTLE_MS);
      let after: CalendarSettings | "missing";
      try {
        after = await deps.settings.read();
      } catch {
        throw Object.assign(new Error("outcome unknown"), { cause: err, unknownOutcome: true });
      }
      if (!(ours(after) && after.lock?.since === since && landed(after))) throw err;
    }
  }

  async function renewLock() {
    const since = deps.now();
    await lockWrite(
      since,
      (s) => {
        if (!ours(s) || !isLockActive(s, since)) throw new Error("lock lost");
        return withLock(s, deps.by, since);
      },
      () => true,
    );
    lockSince = since;
  }

  // Serialized: at most one renewal in flight; concurrent workers await the same one.
  let renewal: Promise<void> | null = null;
  function maybeRenew(): Promise<void> {
    if (renewal) return renewal;
    if (lockSince !== null && deps.now() - lockSince >= LOCK_RENEW_MS) {
      renewal = stepRun("lock", renewLock).finally(() => {
        renewal = null;
      });
      return renewal;
    }
    return Promise.resolve();
  }

  // Bounded concurrency (COPY_CONCURRENCY). The copy budget is checked before each item. On the first
  // failure no new item starts; the call returns only after every in-flight write has settled, so nothing is
  // still writing during the next step, read or verify.
  async function runPool<T>(items: T[], write: (item: T) => Promise<void>) {
    let next = 0;
    let failure: unknown = null;
    const worker = async () => {
      while (failure === null && next < items.length) {
        if (overBudget()) {
          if (failure === null) failure = budgetError();
          return;
        }
        const item = items[next++];
        try {
          await maybeRenew();
          if (failure !== null) return;
          await write(item);
        } catch (err) {
          if (failure === null) failure = err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, items.length) }, worker));
    if (failure !== null) throw failure;
  }

  function upsertAll(events: GoogleEventLike[], tally: { created: number; updated: number }) {
    return runPool(events, async (event) => {
      const result = await deps.target.upsertEvent(event);
      if (result === "updated") tally.updated += 1;
      else tally.created += 1;
    });
  }

  // Cancels sent in this press that Google answered (deleted, or 404/410 = gone).
  const sentCancels = new Set<string>();
  // Occurrences of copied recurring masters (run only after their masters are written). An occurrence
  // Google does not know in the target cannot be fixed by pressing again: fixed, non-resumable message.
  function applyExceptions(items: ExceptionItem[], tally: { applied: number }) {
    return runPool(items, async (item) => {
      try {
        if (item.kind === "cancel") {
          await deps.target.deleteInstance(item.id);
          sentCancels.add(item.id);
        } else {
          await deps.target.updateInstance(item.id, item.body ?? {});
        }
      } catch (err) {
        if ((err as { instanceMissing?: unknown } | null)?.instanceMissing === true) {
          throw new StepError("copy", err, false, EXCEPTION_APPLY_FAILED_MESSAGE);
        }
        throw err;
      }
      tally.applied += 1;
    });
  }

  // Nothing in the target the plan does not account for, per-type counts match, every copied event holds
  // the source's private props (orig_* aside), start and end, and every occurrence item is in place: a
  // modify as written, a cancel either listed cancelled or absent from the target's app view (inside the
  // window: that is what "cancelled" means to the app; DELETE of an occurrence that never existed is 404).
  function verifyTarget(targetEvents: GoogleEventLike[], targetExpanded: GoogleEventLike[], plan: CopyPlan) {
    if (targetConflictCount(plan, targetEvents) > 0) return false;
    const targetPlan = planCopy(targetEvents, targetExpanded, viewWindow);
    const targetById = new Map(targetPlan.copy.map((e) => [e.id as string, e]));
    if (!COPY_KINDS.every((k) => targetPlan.counts[k] === plan.counts[k])) return false;
    const copiedOk = plan.copy.every((e) => {
      const t = targetById.get(e.id as string);
      return !!t && sameCore(t, e);
    });
    if (!copiedOk) return false;
    const listed = new Map(targetEvents.filter((e) => typeof e?.id === "string" && e.recurringEventId).map((e) => [e.id as string, e]));
    const shown = new Set(targetExpanded.map((e) => e?.id).filter((id): id is string => typeof id === "string"));
    return plan.exceptions.every((x) => {
      if (x.kind === "modify") return exceptionVerified(listed.get(x.id), x);
      if (listed.get(x.id)?.status === "cancelled") return true;
      const original = suffixTime(x.id.slice(x.masterId.length + 1));
      // Inside the window: what the app sees decides. Outside it the view cannot tell: Google's answer
      // to this press's DELETE (deleted, or 404/410) is the check.
      if (inWindow(original, viewWindow)) return !shown.has(x.id);
      return sentCancels.has(x.id);
    });
  }

  // The source as the planner needs it: the plain list (masters + exceptions) and the app's view.
  async function readSourcePlan(): Promise<CopyPlan> {
    const events = await listBounded("read", deps.source);
    const expanded = await listBounded("read", deps.source, "expand");
    return planCopy(events, expanded, viewWindow);
  }

  // Clears the lock only if it is still ours; never writes an empty file (withoutLock may yield "missing").
  // A clear that landed but reported an error is recognised by re-reading.
  async function releaseLock(): Promise<boolean> {
    try {
      // Nothing of ours in the file: write nothing (and never touch someone else's lock).
      if (!ours(await deps.settings.read())) return true;
    } catch {
      // fall through: the mutate below reads again
    }
    try {
      await deps.settings.mutate((s) => (ours(s) ? withoutLock(s) : s));
      return true;
    } catch (err) {
      console.error("[calendar-switch] lock release failed:", err instanceof Error ? err.name : typeof err);
      try {
        await sleep(SETTINGS_SETTLE_MS); // the clear may still commit; report what the file then holds
        return !ours(await deps.settings.read());
      } catch {
        return false;
      }
    }
  }

  const flippedTo = (s: CalendarSettings | "missing") => s !== "missing" && sameTarget(s.master, deps.candidate);

  // A preflight that already used the copy budget: refuse before taking the lock (nothing written).
  if (overBudget()) return { ok: false, step: "preflight", error: PREFLIGHT_SLOW_MESSAGE };

  try {
    // 1. lock (atomic check + set; a lock held by anyone else is left untouched)
    await stepRun("lock", async () => {
      const since = deps.now();
      await lockWrite(
        since,
        (s) => {
          if (s === "missing" || !sameTarget(s.candidate, deps.candidate) || !sameTarget(s.master, deps.master)) {
            throw new Error("settings changed");
          }
          if (isLockActive(s, since)) throw new Error("already locked");
          return withLock(s, deps.by, since);
        },
        (s) => s !== "missing" && sameTarget(s.candidate, deps.candidate) && sameTarget(s.master, deps.master),
      );
      lockSince = since;
      lockTakenAt = deps.now(); // the settle wait counts from the CONFIRMED lock, not the stamped since
    });

    // 2. read the source and plan; a plan refusal (the handler refuses it before the lock) stops here,
    //    before any write
    const plan1 = await readSourcePlan();
    if (plan1.refusal) throw new StepError("verify", undefined, false, plan1.refusal);

    // 3. refuse a target that already holds app entries not in the source (they would show up in the app).
    //    The handler refuses this BEFORE the lock (switchPreflight); this is the second line of defense.
    //    The target is listed with deleted entries so cancelled occurrences are always visible.
    const before = await listBounded("verify", deps.target, "deleted");
    if (targetConflictCount(plan1, before) > 0) {
      throw new StepError("verify", undefined, false, TARGET_CONFLICTS_MESSAGE);
    }

    // 4. copy (target ids; insert or update; 5 at a time), then the occurrences of copied recurring
    //    masters. Entries the target already holds exactly as in the source (a re-run after a partial copy)
    //    are not sent again, except occurrences of a master sent again in this press.
    const beforeById = new Map(before.filter((e) => typeof e.id === "string").map((e) => [e.id as string, e]));
    const toCopy = plan1.copy.filter((e) => !targetMatchesSource(beforeById.get(e.id as string), e));
    const unchanged = plan1.copy.length - toCopy.length;
    const tally = { created: 0, updated: 0 };
    await stepRun("copy", () => upsertAll(toCopy, tally));
    const sentMasters = new Set(toCopy.filter(isMasterEvent).map((e) => e.id as string));
    const exceptionsToApply = plan1.exceptions.filter((x) => sentMasters.has(x.masterId) || !exceptionMatches(beforeById.get(x.id), x));
    const exceptionsUnchanged = plan1.exceptions.length - exceptionsToApply.length;
    const exceptionTally = { applied: 0 };
    await stepRun("copy", () => applyExceptions(exceptionsToApply, exceptionTally));

    // 5. settle: any write that passed the lock check before the lock was set has landed by now
    checkBudget();
    const settle = lockTakenAt + SETTLE_MS - deps.now();
    if (settle > 0) await sleep(settle);
    await maybeRenew();

    // 6. re-read the source; copy what appeared or changed since the first read (events first, then the
    //    changed occurrences and every occurrence of a master sent again)
    const plan2 = await readSourcePlan();
    if (plan2.refusal) throw new StepError("verify", undefined, false, plan2.refusal);
    const firstBodies = new Map(plan1.copy.map((e) => [e.id as string, JSON.stringify(e)]));
    const delta = plan2.copy.filter((e) => firstBodies.get(e.id as string) !== JSON.stringify(e));
    await stepRun("copy", () => upsertAll(delta, tally));
    const deltaMasters = new Set(delta.filter(isMasterEvent).map((e) => e.id as string));
    const firstItems = new Map(plan1.exceptions.map((x) => [x.id, JSON.stringify(x)]));
    const exceptionDelta = plan2.exceptions.filter((x) => deltaMasters.has(x.masterId) || firstItems.get(x.id) !== JSON.stringify(x));
    await stepRun("copy", () => applyExceptions(exceptionDelta, exceptionTally));
    checkHard();

    // 7. verify the target against the latest plan, then confirm the source has not moved since
    const after = await listBounded("verify", deps.target, "deleted");
    const targetExpanded = await listBounded("verify", deps.target, "expand");
    if (!verifyTarget(after, targetExpanded, plan2)) throw new StepError("verify");
    // The final authority: the app's view of the target equals the app's view of the source, both ways.
    if (!plan2.occurrences || !sameOccurrences(plan2.occurrences, targetOccurrences(targetExpanded))) throw new StepError("verify");
    // ... and the source (plain list AND app view) has not moved since.
    const plan3 = await readSourcePlan();
    if (!samePlans(plan2, plan3)) throw new StepError("verify");
    await maybeRenew();
    // The flip is allowed only within the hard run deadline (the copy budget governed the copy itself).
    checkHard();

    // 8. flip the pointer, keeping the lock (fresh since) — only if the lock is still ours and active.
    //    A flip that landed but reported an error counts as flipped; an unreadable outcome is "unknown".
    await stepRun("flip", async () => {
      const since = deps.now();
      try {
        await lockWrite(
          since,
          (s) => {
            if (!ours(s) || !isLockActive(s, since) || !sameTarget(s.candidate, deps.candidate) || !sameTarget(s.master, deps.master)) {
              throw new Error("lock lost or settings changed");
            }
            return withLock(promoteCandidate(s, deps.envMaster), deps.by, since);
          },
          flippedTo,
        );
      } catch (err) {
        const unknown = !!(err as { unknownOutcome?: boolean }).unknownOutcome;
        throw new StepError("flip", err, unknown);
      }
      lockSince = since;
    });

    // 9. the master is flipped: nothing below may report failure. Hold the lock past the GET cache TTL,
    //    then clear it (a failed clear is reported as lockCleared: false; the lock then lapses by TTL).
    let lockCleared = false;
    try {
      await sleep(LOCK_HOLD_AFTER_FLIP_MS);
      lockCleared = await releaseLock();
    } catch {
      lockCleared = false;
    }
    return {
      ok: true,
      copied: plan2.copy.length,
      created: tally.created,
      updated: tally.updated,
      unchanged,
      counts: plan2.counts,
      skipped: plan2.skipped,
      exceptions: { ...plan2.diagnostics.exceptions, applied: exceptionTally.applied, unchanged: exceptionsUnchanged },
      lockCleared,
    };
  } catch (err) {
    const stepErr = err instanceof StepError ? err : new StepError("flip", err, true);
    const cause = stepErr.failure;
    console.error(`[calendar-switch] step ${stepErr.step} failed:`, cause instanceof Error ? cause.name : typeof cause);
    // The flip may have landed: keep the lock through the cache hold before releasing it.
    if (stepErr.step === "flip" && stepErr.unknownOutcome) {
      try {
        await sleep(LOCK_HOLD_AFTER_FLIP_MS);
      } catch {
        // release below regardless
      }
    }
    // Any lock write may have landed despite an error, so always try to release (only ours is cleared).
    if (mine.size) await releaseLock();
    return {
      ok: false,
      step: stepErr.step,
      error: stepErr.unknownOutcome ? SWITCH_OUTCOME_UNKNOWN_MESSAGE : stepErr.userMessage ?? SWITCH_STEP_MESSAGES[stepErr.step],
    };
  }
}

// ---- production CalendarClient (network; tests use a fake fetch) -------------------------
export type GoogleClientIO = {
  fetch?: typeof fetch;
  clientId?: string;
  clientSecret?: string;
  sleep?: (ms: number) => Promise<void>;
  maxPages?: number;
  now?: () => number;
  maxAttempts?: number;
};

const API = "https://www.googleapis.com/calendar/v3";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 15_000;
// Total time one upsert (insert + update fallback) or one list page may spend across attempts and backoff,
// so one slow event cannot eat the switch's copy budget.
export const UPSERT_TIME_BUDGET_MS = 30_000;
export const MAX_LIST_PAGES = 200; // 200 x 2,500 events

// Thrown messages are fixed text plus an HTTP status: never a token, never Google's own error text.
class GoogleCalendarError extends Error {
  readonly status: number | undefined;
  readonly deadlineExceeded: boolean;
  // updateInstance only: Google does not know that occurrence (404/410)
  readonly instanceMissing: boolean;
  constructor(message: string, status?: number, deadlineExceeded = false, instanceMissing = false) {
    super(status ? `${message} (HTTP ${status})` : message);
    this.name = "GoogleCalendarError";
    this.status = status;
    this.deadlineExceeded = deadlineExceeded;
    this.instanceMissing = instanceMissing;
  }
}

export function createGoogleCalendarClient(
  t: { calendarId: string; refreshToken: string },
  io: GoogleClientIO = {},
): CalendarClient {
  const doFetch = io.fetch ?? fetch;
  const sleep = io.sleep ?? defaultSleep;
  const maxPages = io.maxPages ?? MAX_LIST_PAGES;
  const now = io.now ?? Date.now;
  const maxAttempts = io.maxAttempts ?? MAX_ATTEMPTS;
  const base = `${API}/calendars/${encodeURIComponent(t.calendarId)}/events`;
  let access: { token: string; expiresAt: number } | null = null;

  async function accessToken() {
    if (access && access.expiresAt > Date.now() + 60_000) return access.token;
    const clientId = io.clientId ?? process.env.AUTH_GOOGLE_ID;
    const clientSecret = io.clientSecret ?? process.env.AUTH_GOOGLE_SECRET;
    if (!clientId || !clientSecret) throw new GoogleCalendarError("Google OAuth client is not configured");
    let response: Response;
    try {
      response = await doFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: t.refreshToken, grant_type: "refresh_token" }),
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GoogleCalendarError("token exchange failed");
    }
    const payload = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (!response.ok || !payload || typeof payload.access_token !== "string") {
      throw new GoogleCalendarError("token exchange failed", response.status);
    }
    access = { token: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000 };
    return access.token;
  }

  // One Calendar request with bounded retries on 429/5xx/network errors, inside a time budget that starts
  // at `startedAt` (shared by an upsert's insert and update). Returns the response (ok or a non-retryable
  // status) for the caller to interpret.
  async function request(url: string, init: RequestInit, startedAt: number, deadline?: number): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      const untilDeadline = deadline === undefined ? Infinity : deadline - now();
      if (untilDeadline <= 0) throw new GoogleCalendarError("calendar request passed the run deadline", undefined, true);
      const remaining = Math.min(UPSERT_TIME_BUDGET_MS - (now() - startedAt), untilDeadline);
      if (remaining <= 0) throw new GoogleCalendarError("calendar request took too long");
      let response: Response | null = null;
      try {
        response = await doFetch(url, {
          ...init,
          headers: {
            authorization: `Bearer ${await accessToken()}`,
            ...(init.body ? { "content-type": "application/json" } : {}),
          },
          cache: "no-store",
          signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
        });
      } catch (err) {
        if (err instanceof GoogleCalendarError) throw err;
        if (attempt >= maxAttempts) throw new GoogleCalendarError("calendar request failed");
      }
      if (response && !RETRY_STATUSES.has(response.status)) return response;
      const wait = 500 * 2 ** (attempt - 1);
      const outOfTime = now() - startedAt + wait >= UPSERT_TIME_BUDGET_MS || (deadline !== undefined && now() + wait >= deadline);
      if (attempt >= maxAttempts || outOfTime) {
        if (response) return response;
        throw new GoogleCalendarError("calendar request failed");
      }
      await sleep(wait);
    }
  }

  return {
    async listEvents(opts) {
      const deadline = opts?.deadline;
      const events: GoogleEventLike[] = [];
      const seenTokens = new Set<string>();
      let pageToken = "";
      for (let page = 0; ; page += 1) {
        if (page >= maxPages) throw new GoogleCalendarError("calendar list has too many pages");
        if (deadline !== undefined && now() >= deadline) {
          throw new GoogleCalendarError("calendar list passed the run deadline", undefined, true);
        }
        const params = opts?.expand
          ? new URLSearchParams({ singleEvents: "true", showDeleted: "false", timeMin: opts.expand.timeMin, timeMax: opts.expand.timeMax, maxResults: "2500", fields: EXPANDED_LIST_FIELDS })
          : new URLSearchParams({ singleEvents: "false", showDeleted: opts?.showDeleted ? "true" : "false", maxResults: "2500" });
        if (opts?.timeZone) params.set("timeZone", opts.timeZone);
        if (pageToken) params.set("pageToken", pageToken);
        const response = await request(`${base}?${params.toString()}`, { method: "GET" }, now(), deadline);
        if (!response.ok) throw new GoogleCalendarError("calendar list failed", response.status);
        const payload = (await response.json().catch(() => null)) as { items?: unknown; nextPageToken?: unknown } | null;
        if (!payload || (payload.items !== undefined && !Array.isArray(payload.items))) {
          throw new GoogleCalendarError("calendar list returned an unexpected body");
        }
        events.push(...((payload.items as GoogleEventLike[] | undefined) ?? []));
        pageToken = typeof payload.nextPageToken === "string" ? payload.nextPageToken : "";
        if (!pageToken) return events;
        if (seenTokens.has(pageToken)) throw new GoogleCalendarError("calendar list repeated a page");
        seenTokens.add(pageToken);
      }
    },

    async upsertEvent(event) {
      if (typeof event.id !== "string" || !event.id) throw new GoogleCalendarError("event has no id");
      const body = JSON.stringify(event);
      const startedAt = now();
      const inserted = await request(`${base}?sendUpdates=none`, { method: "POST", body }, startedAt);
      if (inserted.ok) return "created";
      if (inserted.status !== 409) throw new GoogleCalendarError("calendar insert failed", inserted.status);
      const updated = await request(`${base}/${encodeURIComponent(event.id)}?sendUpdates=none`, { method: "PUT", body }, startedAt);
      if (updated.ok) return "updated";
      throw new GoogleCalendarError("calendar update failed", updated.status);
    },

    async calendarTimeZone(opts) {
      const deadline = opts?.deadline;
      const params = new URLSearchParams({ maxResults: "1", fields: "timeZone" });
      const response = await request(`${base}?${params.toString()}`, { method: "GET" }, now(), deadline);
      if (!response.ok) throw new GoogleCalendarError("calendar time zone read failed", response.status);
      const payload = (await response.json().catch(() => null)) as { timeZone?: unknown } | null;
      return payload && typeof payload.timeZone === "string" && payload.timeZone ? payload.timeZone : null;
    },

    // events.update (PUT) on the occurrence's instance id with the full occurrence makes it a modified
    // exception of its recurring event (documented by Google; nothing is inherited from the master).
    async updateInstance(instanceId, body) {
      const response = await request(`${base}/${encodeURIComponent(instanceId)}?sendUpdates=none`, { method: "PUT", body: JSON.stringify(body) }, now());
      if (response.ok) return;
      if (response.status === 404 || response.status === 410) throw new GoogleCalendarError("calendar instance not found", response.status, false, true);
      throw new GoogleCalendarError("calendar instance update failed", response.status);
    },

    // events.delete on the occurrence's instance id cancels it (observed: 204, then 410 on a repeat; 404 for
    // an occurrence the rule does not have). Not documented by Google: the final expanded gate verifies.
    async deleteInstance(instanceId) {
      const response = await request(`${base}/${encodeURIComponent(instanceId)}?sendUpdates=none`, { method: "DELETE" }, now());
      if (response.ok) return "deleted";
      if (response.status === 404 || response.status === 410) return "gone";
      throw new GoogleCalendarError("calendar instance delete failed", response.status);
    },
  };
}
