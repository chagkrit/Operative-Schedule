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
  listEvents(): Promise<GoogleEventLike[]>;
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

function copyBody(event: GoogleEventLike): GoogleEventLike {
  const out: GoogleEventLike = {};
  for (const key of COPY_FIELDS) {
    if (event[key] !== undefined) out[key] = structuredClone(event[key]) as never;
  }
  return out;
}

const emptyCounts = (): CopyCounts => ({ booking: 0, extra_day: 0, schedule_closure: 0, staff_unavailable: 0, legacy: 0 });

export type CopyPlan = { copy: GoogleEventLike[]; skipped: number; counts: CopyCounts; byMonth: Record<string, number> };

export function planCopy(source: GoogleEventLike[]): CopyPlan {
  const copy: GoogleEventLike[] = [];
  const counts = emptyCounts();
  const byMonth: Record<string, number> = {};
  const seen = new Set<string>();
  let skipped = 0;
  for (const event of source) {
    const kind = classifyEvent(event);
    if (!kind || seen.has(event.id as string)) {
      skipped += 1;
      continue;
    }
    seen.add(event.id as string);
    copy.push(copyBody(event));
    counts[kind] += 1;
    const month = calendarEventDate(event).slice(0, 7) || "unknown";
    byMonth[month] = (byMonth[month] ?? 0) + 1;
  }
  return { copy, skipped, counts, byMonth };
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
export type SwitchStep = "lock" | "read" | "copy" | "verify" | "flip";

export const SWITCH_STEP_MESSAGES: Record<SwitchStep, string> = {
  lock: "เริ่มการเปลี่ยนปฏิทินไม่สำเร็จ (ล็อกการแก้ไขไม่ได้) ยังไม่ได้เปลี่ยนปฏิทิน",
  read: "อ่านข้อมูลจากปฏิทินหลักปัจจุบันไม่สำเร็จ ยังไม่ได้เปลี่ยนปฏิทิน",
  copy: "คัดลอกข้อมูลไปปฏิทินใหม่ไม่สำเร็จ ยังไม่ได้เปลี่ยนปฏิทิน กดเปลี่ยนอีกครั้งเพื่อคัดลอกต่อได้",
  verify: "ตรวจข้อมูลในปฏิทินใหม่แล้วไม่ตรงกับปฏิทินหลัก ยังไม่ได้เปลี่ยนปฏิทิน",
  flip: "บันทึกการเปลี่ยนปฏิทินหลักไม่สำเร็จ ยังไม่ได้เปลี่ยนปฏิทิน",
};

// GET reads may serve settings cached for up to 30 s; the lock stays on this long after the flip so every
// instance has re-read the new master before writes resume.
export const LOCK_HOLD_AFTER_FLIP_MS = 35_000;
// The lock is renewed during a long copy so its 20 min TTL never lapses mid-copy.
export const LOCK_RENEW_MS = 5 * 60_000;

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
};

export type SwitchResult =
  | { ok: true; copied: number; created: number; updated: number; counts: CopyCounts; skipped: number; lockCleared: boolean }
  | { ok: false; step: SwitchStep; error: string };

class StepError extends Error {
  readonly step: SwitchStep;
  readonly failure: unknown;
  constructor(step: SwitchStep, failure?: unknown) {
    super(step);
    this.step = step;
    this.failure = failure;
  }
}

function sameTarget(a: CalendarTarget | undefined, b: CalendarTarget | undefined) {
  if (!a || !b) return !a && !b;
  return a.email === b.email && a.calendarId === b.calendarId && a.sealedRefreshToken === b.sealedRefreshToken;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runSwitch(deps: SwitchDeps): Promise<SwitchResult> {
  const sleep = deps.sleep ?? defaultSleep;
  // Defense in depth: copying a calendar onto itself would rewrite every live event (PUT replaces the
  // whole event). Refuse before taking the lock; the source is never modified.
  const sourceRef = deps.master ?? deps.envMaster;
  if (sourceRef && sameCalendarId(deps.candidate, sourceRef)) {
    return { ok: false, step: "lock", error: SWITCH_STEP_MESSAGES.lock };
  }
  let lock: { since: number; by: string } | null = null;
  const ours = (s: CalendarSettings | "missing"): s is CalendarSettings =>
    s !== "missing" && !!lock && !!s.lock && s.lock.since === lock.since && s.lock.by === lock.by;

  async function stepRun<T>(step: SwitchStep, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw err instanceof StepError ? err : new StepError(step, err);
    }
  }

  // Re-take our own lock with a fresh `since`; refuses (throws) when the lock is no longer ours or expired.
  async function renewLock() {
    const since = deps.now();
    await deps.settings.mutate((s) => {
      if (!ours(s) || !isLockActive(s, since)) throw new Error("lock lost");
      return withLock(s, deps.by, since);
    });
    lock = { since, by: deps.by };
  }

  async function upsertAll(events: GoogleEventLike[], tally: { created: number; updated: number }) {
    for (const event of events) {
      if (lock && deps.now() - lock.since >= LOCK_RENEW_MS) await stepRun("lock", renewLock);
      const result = await deps.target.upsertEvent(event);
      if (result === "updated") tally.updated += 1;
      else tally.created += 1;
    }
  }

  // App-readable target events whose ids are not in the plan would appear in the app after the flip.
  function verifyTarget(targetEvents: GoogleEventLike[], plan: CopyPlan) {
    const planIds = new Set(plan.copy.map((e) => e.id as string));
    const targetPlan = planCopy(targetEvents);
    const targetIds = new Set(targetPlan.copy.map((e) => e.id as string));
    for (const id of targetIds) if (!planIds.has(id)) return false;
    for (const id of planIds) if (!targetIds.has(id)) return false;
    return COPY_KINDS.every((k) => targetPlan.counts[k] === plan.counts[k]);
  }

  // Clears the lock only if it is still ours; never writes an empty file (withoutLock may yield "missing").
  async function releaseLock(): Promise<boolean> {
    try {
      let cleared = false;
      await deps.settings.mutate((s) => {
        if (!ours(s)) return s;
        cleared = true;
        return withoutLock(s);
      });
      lock = null;
      return cleared;
    } catch (err) {
      console.error("[calendar-switch] lock release failed:", err instanceof Error ? err.name : typeof err);
      return false;
    }
  }

  try {
    // 1. lock (atomic check + set; a lock held by anyone else is left untouched)
    await stepRun("lock", async () => {
      const since = deps.now();
      await deps.settings.mutate((s) => {
        if (s === "missing" || !sameTarget(s.candidate, deps.candidate) || !sameTarget(s.master, deps.master)) {
          throw new Error("settings changed");
        }
        if (isLockActive(s, since)) throw new Error("already locked");
        return withLock(s, deps.by, since);
      });
      lock = { since, by: deps.by };
    });

    // 2. read the source and plan
    const plan1 = planCopy(await stepRun("read", () => deps.source.listEvents()));

    // 3. refuse a target that already holds app events not in the source (they would show up in the app)
    const before = await stepRun("verify", () => deps.target.listEvents());
    const planIds1 = new Set(plan1.copy.map((e) => e.id as string));
    if (planCopy(before).copy.some((e) => !planIds1.has(e.id as string))) throw new StepError("verify");

    // 4. copy (same ids; insert or update)
    const tally = { created: 0, updated: 0 };
    await stepRun("copy", () => upsertAll(plan1.copy, tally));

    // 5. re-read the source: copy what appeared or changed since the first read (closes the race with
    //    writes that passed the lock check just before the lock was set)
    const plan2 = planCopy(await stepRun("read", () => deps.source.listEvents()));
    const firstBodies = new Map(plan1.copy.map((e) => [e.id as string, JSON.stringify(e)]));
    const delta = plan2.copy.filter((e) => firstBodies.get(e.id as string) !== JSON.stringify(e));
    await stepRun("copy", () => upsertAll(delta, tally));

    // 6. verify the target against the latest plan
    const after = await stepRun("verify", () => deps.target.listEvents());
    if (!verifyTarget(after, plan2)) throw new StepError("verify");

    // 7. flip the pointer, keeping the lock (fresh since) — only if the lock is still ours and active
    await stepRun("flip", async () => {
      const since = deps.now();
      await deps.settings.mutate((s) => {
        if (!ours(s) || !isLockActive(s, since) || !sameTarget(s.candidate, deps.candidate) || !sameTarget(s.master, deps.master)) {
          throw new Error("lock lost or settings changed");
        }
        return withLock(promoteCandidate(s, deps.envMaster), deps.by, since);
      });
      lock = { since, by: deps.by };
    });

    // 8. the master is flipped: nothing below may report failure. Hold the lock past the GET cache TTL,
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
      counts: plan2.counts,
      skipped: plan2.skipped,
      lockCleared,
    };
  } catch (err) {
    const step = err instanceof StepError ? err.step : "flip";
    const cause = err instanceof StepError ? err.failure : err;
    console.error(`[calendar-switch] step ${step} failed:`, cause instanceof Error ? cause.name : typeof cause);
    if (lock) await releaseLock();
    return { ok: false, step, error: SWITCH_STEP_MESSAGES[step] };
  }
}

// ---- production CalendarClient (network; tests use a fake fetch) -------------------------
export type GoogleClientIO = {
  fetch?: typeof fetch;
  clientId?: string;
  clientSecret?: string;
  sleep?: (ms: number) => Promise<void>;
  maxPages?: number;
};

const API = "https://www.googleapis.com/calendar/v3";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_LIST_PAGES = 200; // 200 x 2,500 events

// Thrown messages are fixed text plus an HTTP status: never a token, never Google's own error text.
class GoogleCalendarError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(status ? `${message} (HTTP ${status})` : message);
    this.name = "GoogleCalendarError";
    this.status = status;
  }
}

export function createGoogleCalendarClient(
  t: { calendarId: string; refreshToken: string },
  io: GoogleClientIO = {},
): CalendarClient {
  const doFetch = io.fetch ?? fetch;
  const sleep = io.sleep ?? defaultSleep;
  const maxPages = io.maxPages ?? MAX_LIST_PAGES;
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

  // One Calendar request with bounded retries on 429/5xx/network errors. Returns the response (ok or a
  // non-retryable status) for the caller to interpret.
  async function request(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      let response: Response | null = null;
      try {
        response = await doFetch(url, {
          ...init,
          headers: {
            authorization: `Bearer ${await accessToken()}`,
            ...(init.body ? { "content-type": "application/json" } : {}),
          },
          cache: "no-store",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof GoogleCalendarError || attempt >= MAX_ATTEMPTS) {
          throw err instanceof GoogleCalendarError ? err : new GoogleCalendarError("calendar request failed");
        }
      }
      if (response && (!RETRY_STATUSES.has(response.status) || attempt >= MAX_ATTEMPTS)) return response;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }

  return {
    async listEvents() {
      const events: GoogleEventLike[] = [];
      const seenTokens = new Set<string>();
      let pageToken = "";
      for (let page = 0; ; page += 1) {
        if (page >= maxPages) throw new GoogleCalendarError("calendar list has too many pages");
        const params = new URLSearchParams({ singleEvents: "false", showDeleted: "false", maxResults: "2500" });
        if (pageToken) params.set("pageToken", pageToken);
        const response = await request(`${base}?${params.toString()}`, { method: "GET" });
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
      const inserted = await request(`${base}?sendUpdates=none`, { method: "POST", body });
      if (inserted.ok) return "created";
      if (inserted.status !== 409) throw new GoogleCalendarError("calendar insert failed", inserted.status);
      const updated = await request(`${base}/${encodeURIComponent(event.id)}?sendUpdates=none`, { method: "PUT", body });
      if (updated.ok) return "updated";
      throw new GoogleCalendarError("calendar update failed", updated.status);
    },
  };
}
