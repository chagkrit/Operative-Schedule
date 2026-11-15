// SERVER-ONLY: small helpers shared by the admin API handlers (users, calendar). The admin gate
// lives here once so every admin handler checks sign-in and role the same way, before any store access.
import { BlobPreconditionFailedError } from "@vercel/blob";
import { SIGN_IN_REQUIRED_MESSAGE, requestUserEmail } from "./session";
import type { UserStore } from "./user-store";

export const ADMIN_ONLY_MESSAGE = "เฉพาะผู้ดูแลระบบเท่านั้น";
export const BAD_REQUEST_MESSAGE = "ข้อมูลที่ส่งมาไม่ถูกต้อง";
export const JSON_REQUIRED_MESSAGE = "รูปแบบคำขอไม่ถูกต้อง ต้องส่งข้อมูลเป็น JSON";

export function jsonNoStore(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// "application/json", any case, optionally with parameters such as "; charset=utf-8".
export function isJsonContentType(value: string | null): boolean {
  return (value ?? "").split(";")[0].trim().toLowerCase() === "application/json";
}

// 401 when not signed in / not allowed, 403 when not an active admin. Nothing else is touched first.
export async function requireAdmin(
  request: Request,
  users: Pick<UserStore, "getAccess">,
): Promise<{ ok: true; actor: string } | { ok: false; response: Response }> {
  let actor: string;
  try {
    actor = await requestUserEmail(request, users as UserStore);
  } catch {
    return { ok: false, response: jsonNoStore({ error: SIGN_IN_REQUIRED_MESSAGE }, 401) };
  }
  if ((await users.getAccess(actor)).role !== "admin") return { ok: false, response: jsonNoStore({ error: ADMIN_ONLY_MESSAGE }, 403) };
  return { ok: true, actor };
}

// Logs the error kind only (SDK messages can carry store paths/ids). A stale-etag write is a 409.
export function storageFailure(prefix: string, err: unknown, concurrentMessage: string, fallback: string) {
  console.error(`[${prefix}] storage error:`, err instanceof Error ? err.name : typeof err);
  if (err instanceof BlobPreconditionFailedError) return jsonNoStore({ error: concurrentMessage }, 409);
  return jsonNoStore({ error: fallback }, 500);
}
