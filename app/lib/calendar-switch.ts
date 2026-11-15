// SERVER-ONLY: the copy engine behind the Admin "switch master calendar" action.
//
// planCopy (pure) decides which events the app can read; runSwitch copies them from the current master
// into the candidate calendar (same event ids, source never modified), verifies the copy, then flips the
// settings pointer while holding the write lock. Google access goes through a small CalendarClient so the
// engine is testable with in-memory fakes.
//
// Never logs event content or tokens: events carry patient identifiers. Failures return fixed Thai text.
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
  listEvents(opts?: { deadline?: number }): Promise<GoogleEventLike[]>;
  upsertEvent(event: GoogleEventLike): Promise<"created" | "updated">;
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
  if (!event || typeof event.id !== "string" || !event.id) return null;
  if (event.status === "cancelled" || event.recurringEventId) return null;
  const data = event.extendedProperties?.private;
  const tag = data?.or_queue;
  if (tag) return TAGS.includes(tag) ? (tag as CopyKind) : null;
  if (parseLegacyCalendarEvent(event)) return "legacy";
  if (data && (data.queue_type === "OR17" || data.queue_type === "EXTRA") && calendarEventDate(event)) return "legacy";
  return null;
}

// Google sets created/updated itself on insert, so the originals travel as private orig_created /
// orig_updated (the readers in legacy-calendar.ts prefer them). Values a source already carries win, so a
// later switch back keeps the first dates.
const ORIG_KEYS = ["orig_created", "orig_updated"] as const;

function copyBody(event: GoogleEventLike): GoogleEventLike {
  const out: GoogleEventLike = {};
  for (const key of COPY_FIELDS) {
    if (event[key] !== undefined) out[key] = structuredClone(event[key]) as never;
  }
  const orig: Record<string, string> = {};
  const existing = event.extendedProperties?.private ?? {};
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
// import) may carry other ids; those cannot be copied with the same id, so a switch refuses up front.
export const GOOGLE_EVENT_ID_PATTERN = /^[a-v0-9]{5,1024}$/;

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
  };
  skippedReasons: { cancelled: number; recurringException: number; notReadable: number };
};

const MAX_SHAPES = 5;
const MAX_SHAPE_LENGTH = 48;

// Run-length shape of an id; the output is ASCII only and never carries a character of the id itself.
// Rules, applied per code point (an emoji is ONE code point):
// - A-Z, a-z, 0-9 form "alphanumeric segments" between separators. Inside a segment, a run of lowercase
//   letters is `l<n>` and a run of uppercase letters is `U<n>`; a digit joins the run before it, a case
//   change starts a new run, and leading digits join the first letter run after them. A segment of only
//   digits is `l<n>`.
// - ASCII punctuation in the allowlist - _ . : @ / + = is kept as is (it separates segments).
// - Every other code point (non-ASCII letters, emoji, whitespace, control characters, other punctuation)
//   becomes `?`, and a run of them is `?<n>`.
// - Truncation happens AFTER masking, by code points, so a surrogate pair is never split.
const SHAPE_PUNCT = "-_.:@/+=";

function segmentShape(segment: string): string {
  const chars = Array.from(segment);
  const caseOf = (c: string): "l" | "U" | null => (/[a-z]/.test(c) ? "l" : /[A-Z]/.test(c) ? "U" : null);
  const firstLetter = chars.map(caseOf).find((c) => c !== null) ?? "l";
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
  const flushSegment = () => {
    if (segment) out += segmentShape(segment);
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

// invalidIds: planned (copied) events whose id GOOGLE_EVENT_ID_PATTERN rejects; skipped events never count.
export type CopyPlan = {
  copy: GoogleEventLike[];
  skipped: number;
  counts: CopyCounts;
  byMonth: Record<string, number>;
  invalidIds: number;
  diagnostics: PlanDiagnostics;
};

export function planCopy(source: GoogleEventLike[]): CopyPlan {
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
  };
  const skippedReasons = { cancelled: 0, recurringException: 0, notReadable: 0 };
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
    const kind = classifyEvent(event);
    if (!kind || seen.has(event.id as string)) {
      skipped += 1;
      if (event?.status === "cancelled") skippedReasons.cancelled += 1;
      else if (event?.recurringEventId) skippedReasons.recurringException += 1;
      else skippedReasons.notReadable += 1;
      continue;
    }
    const id = event.id as string;
    seen.add(id);
    if (isMaster) recurring.mastersPlanned += 1;
    if (!GOOGLE_EVENT_ID_PATTERN.test(id)) {
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
    copy.push(copyBody(event));
    counts[kind] += 1;
    const month = calendarEventDate(event).slice(0, 7) || "unknown";
    byMonth[month] = (byMonth[month] ?? 0) + 1;
  }
  const shapes = [...shapeCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_SHAPES)
    .map(([shape, count]) => ({ shape, count }));
  const shapesOmitted = invalidIds - shapes.reduce((n, x) => n + x.count, 0);
  return { copy, skipped, counts, byMonth, invalidIds, diagnostics: { invalidIds: { reasons, shapes, shapesOmitted, byKind }, recurring, skippedReasons } };
}

// The two refusals a switch decides BEFORE taking the lock (and preview shows):
// - targetConflicts: app events in the target that the source no longer has. The app hard-deletes events
//   (cancellations, closures, extra days, leave), so an old master that was populated before still holds
//   them; switching back would resurrect them, so only a calendar without such events can be the target.
// - invalidIds: source events Google will not accept with the same id.
export function switchPreflight(sourceEvents: GoogleEventLike[], targetEvents: GoogleEventLike[]): { targetConflicts: number; invalidIds: number } {
  const plan = planCopy(sourceEvents);
  const planIds = new Set(plan.copy.map((e) => e.id as string));
  const targetConflicts = planCopy(targetEvents).copy.filter((e) => !planIds.has(e.id as string)).length;
  return { targetConflicts, invalidIds: plan.invalidIds };
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
export const INVALID_EVENT_IDS_MESSAGE =
  "ปฏิทินหลักปัจจุบันมีรายการที่รหัส event ไม่อยู่ในรูปแบบที่ Google ยอมให้คัดลอกด้วยรหัสเดิม (มักเป็นรายการที่นำเข้าจากโปรแกรมอื่น) จึงยังไม่ได้เปลี่ยนปฏิทิน ให้หยุดตรงนี้ ห้ามแก้ไขหรือลบรายการใด ๆ ใน Google Calendar (จะทำให้ข้อมูลการจองหาย) และติดต่อผู้พัฒนา การสลับจะยังถูกบล็อกจนกว่าผู้พัฒนาจะแก้ให้";
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

function samePlans(a: CopyPlan, b: CopyPlan): boolean {
  if (a.copy.length !== b.copy.length) return false;
  const bodies = new Map(a.copy.map((e) => [e.id as string, JSON.stringify(e)]));
  return b.copy.every((e) => bodies.get(e.id as string) === JSON.stringify(e));
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
  async function listBounded(step: SwitchStep, client: CalendarClient): Promise<GoogleEventLike[]> {
    let events: GoogleEventLike[];
    try {
      events = await client.listEvents({ deadline: hardDeadline });
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

  // Bounded concurrency. On the first failure no new upsert starts; the call returns only after every
  // in-flight upsert has settled, so nothing is still writing during the next read or verify.
  async function upsertAll(events: GoogleEventLike[], tally: { created: number; updated: number }) {
    let next = 0;
    let failure: unknown = null;
    const worker = async () => {
      while (failure === null && next < events.length) {
        if (overBudget()) {
          if (failure === null) failure = budgetError();
          return;
        }
        const event = events[next++];
        try {
          await maybeRenew();
          if (failure !== null) return;
          const result = await deps.target.upsertEvent(event);
          if (result === "updated") tally.updated += 1;
          else tally.created += 1;
        } catch (err) {
          if (failure === null) failure = err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, events.length) }, worker));
    if (failure !== null) throw failure;
  }

  // The app-readable target ids must equal the plan's, per-type counts must match, and every copied
  // event must hold the source's private props (orig_* aside), start and end.
  function verifyTarget(targetEvents: GoogleEventLike[], plan: CopyPlan) {
    const targetPlan = planCopy(targetEvents);
    const targetById = new Map(targetPlan.copy.map((e) => [e.id as string, e]));
    const planIds = new Set(plan.copy.map((e) => e.id as string));
    for (const id of targetById.keys()) if (!planIds.has(id)) return false;
    if (!COPY_KINDS.every((k) => targetPlan.counts[k] === plan.counts[k])) return false;
    return plan.copy.every((e) => {
      const t = targetById.get(e.id as string);
      return !!t && sameCore(t, e);
    });
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

    // 2. read the source and plan
    const plan1 = planCopy(await listBounded("read", deps.source));

    // 3. refuse a target that already holds app events not in the source (they would show up in the app).
    //    The handler refuses this BEFORE the lock (switchPreflight); this is the second line of defense.
    const before = await listBounded("verify", deps.target);
    const planIds1 = new Set(plan1.copy.map((e) => e.id as string));
    if (planCopy(before).copy.some((e) => !planIds1.has(e.id as string))) {
      throw new StepError("verify", undefined, false, TARGET_CONFLICTS_MESSAGE);
    }

    // 4. copy (same ids; insert or update; 5 at a time). Events the target already holds exactly as in
    //    the source (a re-run after a partial copy) are not sent again.
    const beforeById = new Map(before.filter((e) => typeof e.id === "string").map((e) => [e.id as string, e]));
    const toCopy = plan1.copy.filter((e) => !targetMatchesSource(beforeById.get(e.id as string), e));
    const unchanged = plan1.copy.length - toCopy.length;
    const tally = { created: 0, updated: 0 };
    await stepRun("copy", () => upsertAll(toCopy, tally));

    // 5. settle: any write that passed the lock check before the lock was set has landed by now
    checkBudget();
    const settle = lockTakenAt + SETTLE_MS - deps.now();
    if (settle > 0) await sleep(settle);
    await maybeRenew();

    // 6. re-read the source; copy what appeared or changed since the first read
    const plan2 = planCopy(await listBounded("read", deps.source));
    const firstBodies = new Map(plan1.copy.map((e) => [e.id as string, JSON.stringify(e)]));
    const delta = plan2.copy.filter((e) => firstBodies.get(e.id as string) !== JSON.stringify(e));
    await stepRun("copy", () => upsertAll(delta, tally));
    checkHard();

    // 7. verify the target against the latest plan, then confirm the source has not moved since
    const after = await listBounded("verify", deps.target);
    if (!verifyTarget(after, plan2)) throw new StepError("verify");
    const plan3 = planCopy(await listBounded("read", deps.source));
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
  constructor(message: string, status?: number, deadlineExceeded = false) {
    super(status ? `${message} (HTTP ${status})` : message);
    this.name = "GoogleCalendarError";
    this.status = status;
    this.deadlineExceeded = deadlineExceeded;
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
        const params = new URLSearchParams({ singleEvents: "false", showDeleted: "false", maxResults: "2500" });
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
  };
}
