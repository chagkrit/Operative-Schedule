// SERVER-ONLY: the Admin "master calendar" API behind app/api/admin/calendar/route.ts.
// Kept out of the route file so the node tests can drive it with a real Auth.js JWT and in-memory
// fakes (no network, no Blob). Never import this from a client component.
//
//   GET                                  → status  (emails, calendar ids, flags; never a token)
//   POST { action: "connect", email, calendarId, refreshToken } → status  (stores a sealed candidate)
//   errors → { error: Thai }  400 bad body / token rejected · 401 not signed in · 403 not admin ·
//                             409 refused / concurrent edit · 415 POST without JSON · 500 storage ·
//                             503 CALENDAR_SETTINGS_KEY not configured
//
// Tokens: never logged, never returned, never in an error message (fixed Thai strings only; the
// underlying errors are swallowed). The admin check comes before ANY settings or Google access.
import { BlobPreconditionFailedError } from "@vercel/blob";
import { ADMIN_ONLY_MESSAGE, JSON_REQUIRED_MESSAGE, BAD_REQUEST_MESSAGE, isJsonContentType } from "./admin-users-api";
import {
  isLockActive,
  setCandidate,
  validateConnectInput,
  type CalendarSettings,
  type CalendarTarget,
} from "./calendar-settings";
import type { CalendarSettingsStore } from "./calendar-settings-store";
import { SIGN_IN_REQUIRED_MESSAGE, requestUserEmail } from "./session";
import { sealToken } from "./token-seal";
import type { UserStore } from "./user-store";
import { normalizeEmail } from "./users";

export type AdminCalendarMethod = "GET" | "POST";

export type AdminCalendarEnv = {
  AUTHORIZED_EMAIL: string;
  GOOGLE_CALENDAR_ID?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  CALENDAR_SETTINGS_KEY?: string;
};

export type VerifyAccount = (a: { refreshToken: string; calendarId: string }) => Promise<{ email: string }>;

export type AdminCalendarDeps = {
  users: Pick<UserStore, "getAccess">;
  settings: CalendarSettingsStore;
  env: AdminCalendarEnv;
  verifyAccount: VerifyAccount;
  now: () => number;
};

export type CalendarStatus = {
  master: { email: string; calendarId: string; source: "settings" | "env" };
  candidate?: { email: string; calendarId: string };
  previousMaster?: { email: string; calendarId: string };
  locked: boolean;
  keyConfigured: boolean;
};

export const KEY_MISSING_MESSAGE = "ยังไม่ได้ตั้งค่า CALENDAR_SETTINGS_KEY";
export const EMAIL_MISMATCH_MESSAGE = "บัญชี Google ของ token ไม่ตรงกับอีเมลที่กรอก";
export const VERIFY_FAILED_MESSAGE = "ตรวจสอบ token และสิทธิ์เข้าถึงปฏิทินไม่สำเร็จ";
export const CONNECT_INPUT_MESSAGE = "ข้อมูลไม่ถูกต้อง กรุณาตรวจอีเมล รหัสปฏิทิน และ refresh token";
export const LOCKED_MESSAGE = "ระบบกำลังเปลี่ยนปฏิทิน กรุณาลองใหม่ในอีกสักครู่";
export const NO_MASTER_MESSAGE = "ยังไม่มีการตั้งค่าปฏิทินหลักในระบบ จึงยังเชื่อมต่อปฏิทินใหม่ไม่ได้";
export const LOAD_FAILED_MESSAGE = "อ่านการตั้งค่าปฏิทินไม่สำเร็จ กรุณาลองใหม่";
export const SAVE_FAILED_MESSAGE = "บันทึกการตั้งค่าปฏิทินไม่สำเร็จ กรุณาลองใหม่";
export const CONCURRENT_EDIT_MESSAGE = "มีการแก้ไขการตั้งค่าปฏิทินพร้อมกัน กรุณาลองใหม่";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Log the error kind only: SDK messages can carry store paths/ids, and Google errors can echo input.
function storageFailure(err: unknown, fallback: string) {
  console.error("[admin-calendar] storage error:", err instanceof Error ? err.name : typeof err);
  if (err instanceof BlobPreconditionFailedError) return json({ error: CONCURRENT_EDIT_MESSAGE }, 409);
  return json({ error: fallback }, 500);
}

function keyUsable(key: string | undefined): key is string {
  if (!key) return false;
  try {
    sealToken("probe", key);
    return true;
  } catch {
    return false;
  }
}

function envMasterTarget(env: AdminCalendarEnv) {
  return { email: normalizeEmail(env.AUTHORIZED_EMAIL), calendarId: env.GOOGLE_CALENDAR_ID || env.AUTHORIZED_EMAIL };
}

// Emails, ids and flags only. Built field by field so a sealed token can never be spread in.
export function buildStatus(settings: CalendarSettings | "missing", deps: Pick<AdminCalendarDeps, "env" | "now">): CalendarStatus {
  const keyConfigured = keyUsable(deps.env.CALENDAR_SETTINGS_KEY);
  if (settings === "missing") {
    return { master: { ...envMasterTarget(deps.env), source: "env" }, locked: false, keyConfigured };
  }
  const pub = (t: CalendarTarget) => ({ email: t.email, calendarId: t.calendarId });
  const status: CalendarStatus = {
    master: { ...pub(settings.master), source: "settings" },
    locked: isLockActive(settings, deps.now()),
    keyConfigured,
  };
  if (settings.candidate) status.candidate = pub(settings.candidate);
  if (settings.previousMaster) status.previousMaster = pub(settings.previousMaster);
  return status;
}

type ActionResult = { status: number; body: unknown };

async function connect(body: Record<string, unknown>, deps: AdminCalendarDeps): Promise<ActionResult> {
  const input = validateConnectInput(body);
  if (!input.ok) return { status: 400, body: { error: CONNECT_INPUT_MESSAGE } };
  const key = deps.env.CALENDAR_SETTINGS_KEY;
  if (!keyUsable(key)) return { status: 503, body: { error: KEY_MISSING_MESSAGE } };
  const { email, calendarId, refreshToken } = input.value;

  // Cheap refusals first: don't spend a Google round trip on a request that cannot be stored.
  let current: CalendarSettings | "missing";
  try {
    current = await deps.settings.read();
  } catch (err) {
    console.error("[admin-calendar] storage error:", err instanceof Error ? err.name : typeof err);
    return { status: 500, body: { error: LOAD_FAILED_MESSAGE } };
  }
  if (current !== "missing" && isLockActive(current, deps.now())) return { status: 409, body: { error: LOCKED_MESSAGE } };
  if (current === "missing" && !deps.env.GOOGLE_REFRESH_TOKEN) return { status: 409, body: { error: NO_MASTER_MESSAGE } };

  let verified: { email: string };
  try {
    verified = await deps.verifyAccount({ refreshToken, calendarId });
  } catch {
    return { status: 400, body: { error: VERIFY_FAILED_MESSAGE } };
  }
  if (normalizeEmail(String(verified?.email ?? "")) !== email) return { status: 400, body: { error: EMAIL_MISMATCH_MESSAGE } };

  const candidate: CalendarTarget = { email, calendarId, sealedRefreshToken: sealToken(refreshToken, key) };
  const next = await deps.settings.mutate((fresh) => {
    // Re-checked on the fresh read: a lock taken since the first read still wins.
    if (fresh !== "missing" && isLockActive(fresh, deps.now())) throw new RefusedError(LOCKED_MESSAGE);
    if (fresh === "missing") {
      // First use: the env calendar becomes the stored master so the candidate has something to replace.
      const envToken = deps.env.GOOGLE_REFRESH_TOKEN;
      if (!envToken) throw new RefusedError(NO_MASTER_MESSAGE);
      const master: CalendarTarget = { ...envMasterTarget(deps.env), sealedRefreshToken: sealToken(envToken, key) };
      return setCandidate({ master }, candidate);
    }
    return setCandidate(fresh, candidate);
  });
  return { status: 200, body: buildStatus(next, deps) };
}

class RefusedError extends Error {}

// Task 4 adds "preview", "switch" and "clearLock" here; an unknown action is a 400.
const POST_ACTIONS: Record<string, (body: Record<string, unknown>, deps: AdminCalendarDeps) => Promise<ActionResult>> = {
  connect,
};

export async function handleAdminCalendar(request: Request, method: AdminCalendarMethod, deps: AdminCalendarDeps): Promise<Response> {
  let actor: string;
  try {
    actor = await requestUserEmail(request, deps.users as UserStore);
  } catch {
    return json({ error: SIGN_IN_REQUIRED_MESSAGE }, 401);
  }
  if ((await deps.users.getAccess(actor)).role !== "admin") return json({ error: ADMIN_ONLY_MESSAGE }, 403);

  if (method === "GET") {
    try {
      return json(buildStatus(await deps.settings.read(), deps));
    } catch (err) {
      return storageFailure(err, LOAD_FAILED_MESSAGE);
    }
  }

  if (!isJsonContentType(request.headers.get("content-type"))) return json({ error: JSON_REQUIRED_MESSAGE }, 415);
  const body: unknown = await request.json().catch(() => undefined);
  if (!isRecord(body) || typeof body.action !== "string" || !Object.hasOwn(POST_ACTIONS, body.action)) {
    return json({ error: BAD_REQUEST_MESSAGE }, 400);
  }
  try {
    const result = await POST_ACTIONS[body.action](body, deps);
    return json(result.body, result.status);
  } catch (err) {
    if (err instanceof RefusedError) return json({ error: err.message }, 409);
    return storageFailure(err, SAVE_FAILED_MESSAGE);
  }
}

// ---- production verifyAccount (network; never called from tests) ----------------------
function idTokenEmail(idToken: unknown): string {
  if (typeof idToken !== "string") throw new Error("no id_token");
  const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
    email?: unknown;
    email_verified?: unknown;
  };
  if (typeof payload.email !== "string" || payload.email_verified === false) throw new Error("no verified email");
  return normalizeEmail(payload.email);
}

// Exchanges the refresh token at Google, reads the account email from the returned ID token, then
// reads the calendar with the access token to prove access. Any failure throws a fixed message.
export async function verifyGoogleAccount(a: { refreshToken: string; calendarId: string }): Promise<{ email: string }> {
  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth client is not configured");
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: a.refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const tokens = (await tokenResponse.json().catch(() => null)) as { access_token?: unknown; id_token?: unknown } | null;
  if (!tokenResponse.ok || !tokens || typeof tokens.access_token !== "string") throw new Error("token exchange failed");
  const email = idTokenEmail(tokens.id_token);
  const calendar = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(a.calendarId)}`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!calendar.ok) throw new Error("calendar not accessible");
  return { email };
}
