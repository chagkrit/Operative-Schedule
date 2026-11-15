// Pure model + rules for the Admin "master calendar" switch. No I/O, no secrets in clear:
// refresh tokens are only ever held here in sealed form (see token-seal.ts).
import { isValidEmail, normalizeEmail } from "./users";

export type CalendarTarget = { email: string; calendarId: string; sealedRefreshToken: string };
export type CalendarSettings = {
  // Absent => the environment master applies (a file may hold only a candidate and/or lock).
  master?: CalendarTarget;
  previousMaster?: CalendarTarget;
  candidate?: CalendarTarget;
  lock?: { since: number; by: string };
};

export const LOCK_TTL_MS = 20 * 60_000;
export const MAX_CALENDAR_ID_LENGTH = 256;
export const MAX_REFRESH_TOKEN_LENGTH = 2048;

export function isLockActive(settings: CalendarSettings, now: number): boolean {
  return !!settings.lock && now - settings.lock.since < LOCK_TTL_MS;
}

export function withLock(settings: CalendarSettings | "missing", by: string, now: number): CalendarSettings {
  return { ...(settings === "missing" ? {} : settings), lock: { since: now, by } };
}

export function withoutLock(settings: CalendarSettings): CalendarSettings {
  const rest = { ...settings };
  delete rest.lock;
  return rest;
}

export function setCandidate(settings: CalendarSettings | "missing", target: CalendarTarget): CalendarSettings {
  return { ...(settings === "missing" ? {} : settings), candidate: target };
}

// candidate -> master; the old master (or envMaster when the file has no master) -> previousMaster;
// candidate and lock are cleared.
export function promoteCandidate(settings: CalendarSettings, envMaster?: CalendarTarget): CalendarSettings {
  if (!settings.candidate) throw new Error("no candidate calendar to promote");
  const previous = settings.master ?? envMaster;
  return previous ? { master: settings.candidate, previousMaster: previous } : { master: settings.candidate };
}

export type ConnectInput = { email: string; calendarId: string; refreshToken: string };

export function validateConnectInput(
  input: unknown,
): { ok: true; value: ConnectInput } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "invalid input" };
  const o = input as { email?: unknown; calendarId?: unknown; refreshToken?: unknown };
  if (typeof o.email !== "string" || !isValidEmail(o.email)) return { ok: false, error: "invalid email" };
  const id = o.calendarId;
  if (typeof id !== "string" || !id || id.length > MAX_CALENDAR_ID_LENGTH || /\s/.test(id)) {
    return { ok: false, error: "invalid calendar id" };
  }
  const tok = o.refreshToken;
  if (typeof tok !== "string" || !tok || tok.length > MAX_REFRESH_TOKEN_LENGTH) {
    return { ok: false, error: "invalid refresh token" };
  }
  return { ok: true, value: { email: normalizeEmail(o.email), calendarId: id, refreshToken: tok } };
}
