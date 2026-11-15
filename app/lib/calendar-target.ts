// SERVER-ONLY: decides, per request, which Google Calendar and refresh token the app talks to.
// A settings file (Admin "master calendar" switch) wins; with no settings file the environment
// behaves exactly as before. Inputs are injected so this is testable without network.
// Never logs; error messages never contain a token or the key.
import { isLockActive, type CalendarSettings } from "./calendar-settings";
import { openToken } from "./token-seal";
import { normalizeEmail } from "./users";

export const MASTER_PLACEHOLDER = "@master";
export const CALENDAR_LOCKED_MESSAGE = "ระบบกำลังเปลี่ยนปฏิทิน กรุณาลองใหม่ในอีกสักครู่";
export const CALENDAR_SETTINGS_UNREADABLE_MESSAGE = "อ่านการตั้งค่าปฏิทินไม่สำเร็จ กรุณาลองใหม่";
// Every Calendar write (non-GET) must get its response headers within this many ms of the moment just
// before its lock-check settings read, else it is aborted (googleFetch + sendWithDeadline). The abort
// timer is armed only around sending (after auth/settings/token work) and cleared when headers arrive,
// so a response body is never aborted. Must stay well below SETTLE_MS in calendar-switch.ts (45 s).
export const CALENDAR_WRITE_DEADLINE_MS = 30_000;

// The Calendar API path with the master placeholder replaced by the URL-encoded calendar id (first
// occurrence, path segment only). A replacer function, so no `$` pattern in an id is ever interpreted.
export function resolveCalendarPath(path: string, calendarId: string): string {
  return path.replace(`/calendars/${MASTER_PLACEHOLDER}/`, () => `/calendars/${encodeURIComponent(calendarId)}/`);
}

export type ResolvedCalendarTarget = {
  source: "settings" | "env";
  calendarId: string;
  refreshToken: string | null;
  locked: boolean;
};

export type CalendarTargetOptions = {
  store: { read(opts?: { allowCached?: boolean }): Promise<CalendarSettings | "missing"> };
  env: { GOOGLE_CALENDAR_ID?: string; AUTHORIZED_EMAIL: string; GOOGLE_REFRESH_TOKEN?: string; CALENDAR_SETTINGS_KEY?: string };
  now: number;
  // GET reads may use the store's short success-only cache; writes always read fresh.
  allowCached?: boolean;
};

// The Google account of the calendar the app uses now (shown in the header): the settings master's email,
// else the env account. Email only; null when the settings cannot be read (the caller falls back).
export async function calendarOwnerEmail(opts: Pick<CalendarTargetOptions, "store" | "env">): Promise<string | null> {
  let settings: CalendarSettings | "missing";
  try {
    settings = await opts.store.read({ allowCached: true });
  } catch {
    return null;
  }
  if (settings !== "missing" && settings.master) return settings.master.email;
  return normalizeEmail(opts.env.AUTHORIZED_EMAIL);
}

function unreadable() {
  return Object.assign(new Error(CALENDAR_SETTINGS_UNREADABLE_MESSAGE), { status: 503 });
}

export async function resolveCalendarTarget(opts: CalendarTargetOptions): Promise<ResolvedCalendarTarget> {
  let settings: CalendarSettings | "missing";
  try {
    settings = await opts.store.read({ allowCached: opts.allowCached === true });
  } catch {
    throw unreadable(); // no fallback to env: a transient read error must not write to the wrong calendar
  }
  // No file, or a file with no master (only a candidate and/or lock): the environment applies.
  // An active lock is still honored in the second case.
  if (settings === "missing" || !settings.master) {
    return {
      source: "env",
      calendarId: opts.env.GOOGLE_CALENDAR_ID || opts.env.AUTHORIZED_EMAIL,
      refreshToken: opts.env.GOOGLE_REFRESH_TOKEN || null,
      locked: settings !== "missing" && isLockActive(settings, opts.now),
    };
  }
  let refreshToken: string;
  try {
    refreshToken = openToken(settings.master.sealedRefreshToken, opts.env.CALENDAR_SETTINGS_KEY ?? "");
  } catch {
    throw unreadable();
  }
  // An empty grant would fall through to the per-device path against the settings calendar: fail closed.
  if (!refreshToken) throw unreadable();
  return {
    source: "settings",
    calendarId: settings.master.calendarId,
    refreshToken,
    locked: isLockActive(settings, opts.now),
  };
}
