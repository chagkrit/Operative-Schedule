// SERVER-ONLY: the Admin "master calendar" API behind app/api/admin/calendar/route.ts.
// Kept out of the route file so the node tests can drive it with a real Auth.js JWT and in-memory
// fakes (no network, no Blob). Never import this from a client component.
//
//   GET                                  → status  (emails, calendar ids, flags; never a token)
//   POST { action: "connect", email, calendarId, refreshToken } → status  (stores a sealed candidate)
//   POST { action: "preview" }   → counts / skipped / byMonth / target info (never event content), or
//                                  { tokenOnly: true } when the candidate is the master's own calendar
//   POST { action: "switch" }    → preflight (no lock: refuses target conflicts / a plan refusal) then
//                                  copy + verify + flip (calendar-switch.ts), or a token-only refresh
//   POST { action: "clearLock" } → status  (clears a switch lock; a lock-only file is deleted, never {})
//   errors → { error: Thai }  400 bad body / token rejected · 401 not signed in · 403 not admin ·
//                             409 refused / concurrent edit / preflight refusal ({ error, step: "preflight" }) ·
//                             415 POST without JSON · 500 storage ·
//                             502 switch/preview Google step failed ({ error, step }) ·
//                             503 CALENDAR_SETTINGS_KEY not configured
//
// Tokens: never logged, never returned, never in an error message (fixed Thai strings only; the
// underlying errors are swallowed). The admin check comes before ANY settings or Google access.
import {
  BAD_REQUEST_MESSAGE,
  JSON_REQUIRED_MESSAGE,
  isJsonContentType,
  isRecord,
  jsonNoStore as json,
  requireAdmin,
  storageFailure as sharedStorageFailure,
} from "./admin-http";
import {
  isLockActive,
  setCandidate,
  validateConnectInput,
  withoutLock,
  type CalendarSettings,
  type CalendarTarget,
} from "./calendar-settings";
import type { CalendarSettingsStore } from "./calendar-settings-store";
import {
  COPY_PHASE_BUDGET_MS,
  countRecurring,
  isSameCalendar,
  planCopy,
  PREFLIGHT_TARGET_FAILED_MESSAGE,
  sameCalendarId,
  sameCalendarTarget,
  SWITCH_OUTCOME_UNKNOWN_MESSAGE,
  SWITCH_STEP_MESSAGES,
  runSwitch,
  switchPreflight,
  TARGET_CONFLICTS_MESSAGE,
  withRefreshedMasterToken,
  type CalendarClient,
} from "./calendar-switch";
import { openToken, sealToken } from "./token-seal";
import type { UserStore } from "./user-store";
import { normalizeEmail } from "./users";

export type AdminCalendarMethod = "GET" | "POST";

export type AdminCalendarEnv = {
  AUTHORIZED_EMAIL: string;
  GOOGLE_CALENDAR_ID?: string;
  CALENDAR_SETTINGS_KEY?: string;
  // The env master's grant; read only by preview/switch while the file has no master.
  GOOGLE_REFRESH_TOKEN?: string;
};

export type VerifyAccount = (a: { refreshToken: string; calendarId: string }) => Promise<{ email: string }>;

export type AdminCalendarDeps = {
  users: Pick<UserStore, "getAccess">;
  settings: CalendarSettingsStore;
  env: AdminCalendarEnv;
  verifyAccount: VerifyAccount;
  now: () => number;
  // Builds a Calendar client for one calendar + refresh token (production: createGoogleCalendarClient).
  makeClient: (t: { calendarId: string; refreshToken: string }) => CalendarClient;
  sleep?: (ms: number) => Promise<void>;
};

export type CalendarStatus = {
  master: { email: string; calendarId: string; source: "settings" | "env" };
  candidate?: { email: string; calendarId: string };
  previousMaster?: { email: string; calendarId: string };
  locked: boolean;
  // Epoch ms the active lock was taken (only while locked); the Admin screen warns before clearing a fresh one.
  lockedSince?: number;
  keyConfigured: boolean;
};

export const KEY_MISSING_MESSAGE = "ยังไม่ได้ตั้งค่า CALENDAR_SETTINGS_KEY";
export const EMAIL_MISMATCH_MESSAGE = "บัญชี Google ของ token ไม่ตรงกับอีเมลที่กรอก";
export const VERIFY_FAILED_MESSAGE = "ตรวจสอบ token และสิทธิ์เข้าถึงปฏิทินไม่สำเร็จ";
export const CONNECT_INPUT_MESSAGE = "ข้อมูลไม่ถูกต้อง กรุณาตรวจอีเมล รหัสปฏิทิน และ refresh token";
export const LOCKED_MESSAGE = "ระบบกำลังเปลี่ยนปฏิทิน กรุณาลองใหม่ในอีกสักครู่";
export const LOAD_FAILED_MESSAGE = "อ่านการตั้งค่าปฏิทินไม่สำเร็จ กรุณาลองใหม่";
export const SAVE_FAILED_MESSAGE = "บันทึกการตั้งค่าปฏิทินไม่สำเร็จ กรุณาลองใหม่";
export const CONCURRENT_EDIT_MESSAGE = "มีการแก้ไขการตั้งค่าปฏิทินพร้อมกัน กรุณาลองใหม่";
export const NO_CANDIDATE_MESSAGE = "ยังไม่ได้เชื่อมต่อปฏิทินใหม่";
export const NO_SOURCE_TOKEN_MESSAGE = "ไม่มี GOOGLE_REFRESH_TOKEN ของปฏิทินหลักปัจจุบัน จึงคัดลอกข้อมูลไม่ได้";
export const TOKEN_OPEN_FAILED_MESSAGE = "เปิดอ่าน token ที่บันทึกไว้ไม่สำเร็จ กรุณาตรวจ CALENDAR_SETTINGS_KEY หรือเชื่อมต่อใหม่";
export const PREVIEW_SOURCE_FAILED_MESSAGE = "อ่านข้อมูลจากปฏิทินหลักปัจจุบันไม่สำเร็จ";
export const PREVIEW_TARGET_FAILED_MESSAGE = "อ่านข้อมูลจากปฏิทินใหม่ไม่สำเร็จ";
export const SWITCHED_WITH_ERROR_MESSAGE = "เปลี่ยนปฏิทินหลักเป็นปฏิทินใหม่แล้ว แต่ระบบรายงานข้อผิดพลาดระหว่างทาง กรุณาตรวจหน้าสถานะ";
export const SAME_CALENDAR_OTHER_ACCOUNT_MESSAGE = "ปฏิทินใหม่คือปฏิทินหลักเดิม (เชื่อมผ่านคนละบัญชี) จึงเปลี่ยนแบบคัดลอกไม่ได้";

function storageFailure(err: unknown, fallback: string) {
  return sharedStorageFailure("admin-calendar", err, CONCURRENT_EDIT_MESSAGE, fallback);
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
  // A file without a master means the env master still applies.
  const status: CalendarStatus = {
    master: settings.master ? { ...pub(settings.master), source: "settings" } : { ...envMasterTarget(deps.env), source: "env" },
    locked: isLockActive(settings, deps.now()),
    keyConfigured,
  };
  if (status.locked && settings.lock) status.lockedSince = settings.lock.since;
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
    return setCandidate(fresh, candidate);
  });
  return { status: 200, body: buildStatus(next, deps) };
}

class RefusedError extends Error {}

// ---- preview / switch / clearLock ---------------------------------------------------------
type SwitchContext = {
  key: string;
  settings: CalendarSettings;
  candidate: CalendarTarget;
  // The calendar the app uses now: the settings master, else the env master (public fields only).
  current: { email: string; calendarId: string };
};

// Shared refusals for preview and switch, in a fixed order: key, settings readable, candidate present.
async function switchContext(deps: AdminCalendarDeps): Promise<{ ok: true; ctx: SwitchContext } | { ok: false; result: ActionResult }> {
  const key = deps.env.CALENDAR_SETTINGS_KEY;
  if (!keyUsable(key)) return { ok: false, result: { status: 503, body: { error: KEY_MISSING_MESSAGE } } };
  let settings: CalendarSettings | "missing";
  try {
    settings = await deps.settings.read();
  } catch (err) {
    console.error("[admin-calendar] storage error:", err instanceof Error ? err.name : typeof err);
    return { ok: false, result: { status: 500, body: { error: LOAD_FAILED_MESSAGE } } };
  }
  if (settings === "missing" || !settings.candidate) return { ok: false, result: { status: 409, body: { error: NO_CANDIDATE_MESSAGE } } };
  const current = settings.master ? { email: settings.master.email, calendarId: settings.master.calendarId } : envMasterTarget(deps.env);
  return { ok: true, ctx: { key, settings, candidate: settings.candidate, current } };
}

// Opens the source (current master) and target (candidate) grants. Tokens stay in this function's callers'
// memory only; failures map to fixed Thai messages.
function openGrants(ctx: SwitchContext, env: AdminCalendarEnv): { ok: true; source: string; target: string } | { ok: false; result: ActionResult } {
  let source: string;
  if (ctx.settings.master) {
    try {
      source = openToken(ctx.settings.master.sealedRefreshToken, ctx.key);
    } catch {
      return { ok: false, result: { status: 500, body: { error: TOKEN_OPEN_FAILED_MESSAGE } } };
    }
  } else {
    if (!env.GOOGLE_REFRESH_TOKEN) return { ok: false, result: { status: 409, body: { error: NO_SOURCE_TOKEN_MESSAGE } } };
    source = env.GOOGLE_REFRESH_TOKEN;
  }
  try {
    return { ok: true, source, target: openToken(ctx.candidate.sealedRefreshToken, ctx.key) };
  } catch {
    return { ok: false, result: { status: 500, body: { error: TOKEN_OPEN_FAILED_MESSAGE } } };
  }
}

async function preview(_body: Record<string, unknown>, deps: AdminCalendarDeps): Promise<ActionResult> {
  const c = await switchContext(deps);
  if (!c.ok) return c.result;
  const { ctx } = c;
  if (isSameCalendar(ctx.candidate, ctx.current)) return { status: 200, body: { tokenOnly: true } };
  if (sameCalendarId(ctx.candidate, ctx.current)) return { status: 409, body: { error: SAME_CALENDAR_OTHER_ACCOUNT_MESSAGE } };
  const grants = openGrants(ctx, deps.env);
  if (!grants.ok) return grants.result;
  const source = deps.makeClient({ calendarId: ctx.current.calendarId, refreshToken: grants.source });
  const target = deps.makeClient({ calendarId: ctx.candidate.calendarId, refreshToken: grants.target });
  let plan: ReturnType<typeof planCopy>;
  let recurring: number;
  let sourceEvents: Awaited<ReturnType<CalendarClient["listEvents"]>>;
  try {
    sourceEvents = await source.listEvents();
    plan = planCopy(sourceEvents);
    recurring = countRecurring(sourceEvents);
  } catch (err) {
    console.error("[admin-calendar] preview source read failed:", err instanceof Error ? err.name : typeof err);
    return { status: 502, body: { error: PREVIEW_SOURCE_FAILED_MESSAGE } };
  }
  let targetEvents: Awaited<ReturnType<CalendarClient["listEvents"]>>;
  try {
    targetEvents = await target.listEvents();
  } catch (err) {
    console.error("[admin-calendar] preview target read failed:", err instanceof Error ? err.name : typeof err);
    return { status: 502, body: { error: PREVIEW_TARGET_FAILED_MESSAGE } };
  }
  // Counts and month keys only: events carry patient identifiers and never leave the server.
  // Same rule as the switch's preflight (switchPreflight), so preview and switch cannot drift.
  // invalidIds = events copied under a new id (informational); planBlocked = fixed Thai refusal or null.
  const { targetConflicts, invalidIds, exceptions, refusal } = switchPreflight(sourceEvents, targetEvents);
  return {
    status: 200,
    body: {
      tokenOnly: false,
      counts: plan.counts,
      skipped: plan.skipped,
      byMonth: plan.byMonth,
      targetEventCount: targetEvents.length,
      targetHasEvents: targetEvents.length > 0,
      targetConflicts,
      invalidIds,
      recurring,
      exceptions,
      planBlocked: refusal,
      diagnostics: plan.diagnostics,
    },
  };
}

async function switchMaster(_body: Record<string, unknown>, deps: AdminCalendarDeps, actor: string): Promise<ActionResult> {
  const c = await switchContext(deps);
  if (!c.ok) return c.result;
  const { ctx } = c;
  if (isLockActive(ctx.settings, deps.now())) return { status: 409, body: { error: LOCKED_MESSAGE } };

  const envMasterSealed = (): CalendarTarget | undefined =>
    !ctx.settings.master && deps.env.GOOGLE_REFRESH_TOKEN
      ? { ...envMasterTarget(deps.env), sealedRefreshToken: sealToken(deps.env.GOOGLE_REFRESH_TOKEN, ctx.key) }
      : undefined;

  // Same account + calendar: renew the token only (no copy, no Google call).
  if (isSameCalendar(ctx.candidate, ctx.current)) {
    const expected = ctx.candidate;
    const next = await deps.settings.mutate((fresh) => {
      if (fresh === "missing" || !fresh.candidate || fresh.candidate.sealedRefreshToken !== expected.sealedRefreshToken) {
        throw new RefusedError(CONCURRENT_EDIT_MESSAGE);
      }
      if (isLockActive(fresh, deps.now())) throw new RefusedError(LOCKED_MESSAGE);
      if (fresh.master && !isSameCalendar(fresh.candidate, fresh.master)) throw new RefusedError(CONCURRENT_EDIT_MESSAGE);
      // Env mode: previousMaster stays unset (it would point at the same calendar with the old token).
      return withRefreshedMasterToken(fresh);
    });
    return { status: 200, body: { mode: "token", status: buildStatus(next, deps) } };
  }
  // Same calendar through another account: a copy onto itself would rewrite every live event.
  if (sameCalendarId(ctx.candidate, ctx.current)) return { status: 409, body: { error: SAME_CALENDAR_OTHER_ACCOUNT_MESSAGE } };

  const grants = openGrants(ctx, deps.env);
  if (!grants.ok) return grants.result;
  // The same two clients serve the preflight and the run (each caches its own access token).
  const source = deps.makeClient({ calendarId: ctx.current.calendarId, refreshToken: grants.source });
  const target = deps.makeClient({ calendarId: ctx.candidate.calendarId, refreshToken: grants.target });

  // Preflight, WITHOUT a lock: refusals that can be decided up front must never freeze writes. Bounded by
  // the copy budget; the run's budget and hard deadline count from the same start (route maxDuration).
  const runStart = deps.now();
  const preflightDeadline = runStart + COPY_PHASE_BUDGET_MS;
  const refuse = (status: number, error: string, step: "preflight" | "read" = "preflight"): ActionResult =>
    ({ status, body: { error, step, switched: false } });
  let sourceEvents: Awaited<ReturnType<CalendarClient["listEvents"]>>;
  try {
    sourceEvents = await source.listEvents({ deadline: preflightDeadline });
  } catch (err) {
    console.error("[admin-calendar] switch preflight source read failed:", err instanceof Error ? err.name : typeof err);
    return refuse(502, SWITCH_STEP_MESSAGES.read, "read");
  }
  let targetEvents: Awaited<ReturnType<CalendarClient["listEvents"]>>;
  try {
    targetEvents = await target.listEvents({ deadline: preflightDeadline });
  } catch (err) {
    console.error("[admin-calendar] switch preflight target read failed:", err instanceof Error ? err.name : typeof err);
    return refuse(502, PREFLIGHT_TARGET_FAILED_MESSAGE);
  }
  const blockers = switchPreflight(sourceEvents, targetEvents);
  if (blockers.targetConflicts > 0) return refuse(409, TARGET_CONFLICTS_MESSAGE);
  if (blockers.refusal) return refuse(409, blockers.refusal);

  const result = await runSwitch({
    settings: deps.settings,
    source,
    target,
    by: actor,
    now: deps.now,
    candidate: ctx.candidate,
    master: ctx.settings.master,
    envMaster: envMasterSealed(),
    sleep: deps.sleep,
    runStart,
  });
  if (!result.ok) {
    // Report what the file really holds: never "not switched" when the master is already the candidate.
    let after: CalendarSettings | "missing" | null = null;
    try {
      after = await deps.settings.read();
    } catch {
      after = null;
    }
    if (after && after !== "missing" && sameCalendarTarget(after.master, ctx.candidate)) {
      return { status: 500, body: { error: SWITCHED_WITH_ERROR_MESSAGE, step: result.step, switched: true, status: buildStatus(after, deps) } };
    }
    if (after === null && result.step === "flip") {
      return { status: 500, body: { error: SWITCH_OUTCOME_UNKNOWN_MESSAGE, step: result.step } };
    }
    const status = result.step === "lock" || result.step === "preflight" ? 409 : result.step === "flip" ? 500 : 502;
    return { status, body: { error: result.error, step: result.step, switched: false } };
  }
  let status: CalendarStatus | undefined;
  try {
    status = buildStatus(await deps.settings.read(), deps);
  } catch {
    status = undefined; // the switch itself succeeded; the page can re-read the status
  }
  return {
    status: 200,
    body: {
      mode: "copy",
      copied: result.copied,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      counts: result.counts,
      skipped: result.skipped,
      exceptions: result.exceptions,
      lockCleared: result.lockCleared,
      status,
    },
  };
}

async function clearLock(_body: Record<string, unknown>, deps: AdminCalendarDeps): Promise<ActionResult> {
  let current: CalendarSettings | "missing";
  try {
    current = await deps.settings.read();
  } catch (err) {
    console.error("[admin-calendar] storage error:", err instanceof Error ? err.name : typeof err);
    return { status: 500, body: { error: LOAD_FAILED_MESSAGE } };
  }
  if (current === "missing" || !current.lock) return { status: 200, body: buildStatus(current, deps) };
  // withoutLock turns a lock-only file into "missing", which the store deletes (never writes {}).
  const next = await deps.settings.mutate((fresh) => (fresh !== "missing" && fresh.lock ? withoutLock(fresh) : fresh));
  return { status: 200, body: buildStatus(next, deps) };
}

// An unknown action is a 400. `actor` is the signed-in admin (from requireAdmin).
const POST_ACTIONS: Record<string, (body: Record<string, unknown>, deps: AdminCalendarDeps, actor: string) => Promise<ActionResult>> = {
  connect,
  preview,
  switch: switchMaster,
  clearLock,
};

export async function handleAdminCalendar(request: Request, method: AdminCalendarMethod, deps: AdminCalendarDeps): Promise<Response> {
  const gate = await requireAdmin(request, deps.users);
  if (!gate.ok) return gate.response;

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
    const result = await POST_ACTIONS[body.action](body, deps, gate.actor);
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
  // Fail closed: only an explicit boolean true counts as verified.
  if (typeof payload.email !== "string" || payload.email_verified !== true) throw new Error("no verified email");
  return normalizeEmail(payload.email);
}

// Exchanges the refresh token at Google, reads the account email from the returned ID token, then
// reads the calendar with the access token to prove access. Any failure throws a fixed message.
export async function verifyGoogleAccount(
  a: { refreshToken: string; calendarId: string },
  io: { fetch?: typeof fetch; clientId?: string; clientSecret?: string } = {},
): Promise<{ email: string }> {
  const doFetch = io.fetch ?? fetch;
  const clientId = io.clientId ?? process.env.AUTH_GOOGLE_ID;
  const clientSecret = io.clientSecret ?? process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth client is not configured");
  const tokenResponse = await doFetch("https://oauth2.googleapis.com/token", {
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
  // events.list, not calendars.get: the only Calendar scope the token script mints is calendar.events,
  // which events.list accepts and calendars.get does not.
  const probe = await doFetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(a.calendarId)}/events?maxResults=1`,
    {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!probe.ok) throw new Error("calendar not accessible");
  return { email };
}
