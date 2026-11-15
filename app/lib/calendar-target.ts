// SERVER-ONLY: decides, per request, which Google Calendar and refresh token the app talks to.
// A settings file (Admin "master calendar" switch) wins; with no settings file the environment
// behaves exactly as before. Inputs are injected so this is testable without network.
// Never logs; error messages never contain a token or the key.
import { isLockActive, type CalendarSettings } from "./calendar-settings";
import { openToken } from "./token-seal";

export const MASTER_PLACEHOLDER = "@master";
export const CALENDAR_LOCKED_MESSAGE = "ระบบกำลังเปลี่ยนปฏิทิน กรุณาลองใหม่ในอีกสักครู่";
export const CALENDAR_SETTINGS_UNREADABLE_MESSAGE = "อ่านการตั้งค่าปฏิทินไม่สำเร็จ กรุณาลองใหม่";

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
  if (settings === "missing") {
    return {
      source: "env",
      calendarId: opts.env.GOOGLE_CALENDAR_ID || opts.env.AUTHORIZED_EMAIL,
      refreshToken: opts.env.GOOGLE_REFRESH_TOKEN || null,
      locked: false,
    };
  }
  let refreshToken: string;
  try {
    refreshToken = openToken(settings.master.sealedRefreshToken, opts.env.CALENDAR_SETTINGS_KEY ?? "");
  } catch {
    throw unreadable();
  }
  return {
    source: "settings",
    calendarId: settings.master.calendarId,
    refreshToken,
    locked: isLockActive(settings, opts.now),
  };
}
