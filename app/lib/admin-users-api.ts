// SERVER-ONLY: the admin allowlist API behind app/api/admin/users/route.ts.
// Kept out of the route file so the node tests can drive it with a real Auth.js JWT and an
// in-memory store (no network, no Blob). Never import this from a client component.
//
//   GET    → { users }
//   POST   { email, role }            → { users }   add (active)
//   PATCH  { email, role?, active? }  → { users }   both changes or neither
//   DELETE { email }                  → { users }
//   errors → { error: Thai }  400 bad body · 401 not signed in/allowed · 403 not admin ·
//                             404 unknown email · 409 rule refused / concurrent edit ·
//                             415 POST/PATCH/DELETE without a JSON Content-Type · 500 storage
//
// Mutation responses carry the list returned by `store.mutate` (fresh read → change → write),
// never a separate list() that a stale cache could answer.
import {
  ADMIN_ONLY_MESSAGE,
  BAD_REQUEST_MESSAGE,
  JSON_REQUIRED_MESSAGE,
  isJsonContentType,
  isRecord,
  jsonNoStore as json,
  requireAdmin,
  storageFailure as sharedStorageFailure,
} from "./admin-http";
import type { UserStore } from "./user-store";
import {
  USER_ERRORS,
  addUser,
  findAccess,
  isValidEmail,
  normalizeEmail,
  removeUser,
  setActive,
  setRole,
  type Result,
  type Role,
  type UserRecord,
} from "./users";

export type AdminUsersMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type AdminAction =
  | { kind: "add"; email: string; role: Role }
  | { kind: "update"; email: string; role?: Role; active?: boolean }
  | { kind: "remove"; email: string };

export type ParsedBody = { ok: true; action: AdminAction } | { ok: false; error: string };

// Re-exported so existing importers keep working; the definitions live in admin-http.ts.
export { ADMIN_ONLY_MESSAGE, BAD_REQUEST_MESSAGE, JSON_REQUIRED_MESSAGE, isJsonContentType };
export const CONCURRENT_EDIT_MESSAGE = "มีการแก้ไขรายชื่อพร้อมกัน กรุณาลองใหม่";
export const NOTHING_TO_CHANGE_MESSAGE = "กรุณาระบุสิทธิ์หรือสถานะที่ต้องการเปลี่ยน";
export const LOAD_FAILED_MESSAGE = "อ่านรายชื่อผู้ใช้ไม่สำเร็จ กรุณาลองใหม่";
export const SAVE_FAILED_MESSAGE = "บันทึกรายชื่อผู้ใช้ไม่สำเร็จ กรุณาลองใหม่";

// Longer than any valid email (254), so a legacy malformed entry can still be removed.
const MAX_TARGET_LENGTH = 320;

function isRole(v: unknown): v is Role {
  return v === "user" || v === "admin" || v === "viewer";
}

function targetEmail(body: Record<string, unknown>): string | null {
  if (typeof body.email !== "string") return null;
  const email = normalizeEmail(body.email);
  return email && email.length <= MAX_TARGET_LENGTH ? email : null;
}

// Shape and type checks of a request body (already JSON-parsed). Pure.
export function parseAdminUsersBody(method: string, body: unknown): ParsedBody {
  if (!isRecord(body)) return { ok: false, error: BAD_REQUEST_MESSAGE };
  const email = targetEmail(body);
  if (method === "POST") {
    if (!email || !isValidEmail(email)) return { ok: false, error: USER_ERRORS.invalidEmail };
    if (!isRole(body.role)) return { ok: false, error: USER_ERRORS.invalidRole };
    return { ok: true, action: { kind: "add", email, role: body.role } };
  }
  if (method === "PATCH") {
    if (!email) return { ok: false, error: USER_ERRORS.invalidEmail };
    if (body.role !== undefined && !isRole(body.role)) return { ok: false, error: USER_ERRORS.invalidRole };
    if (body.active !== undefined && typeof body.active !== "boolean") return { ok: false, error: USER_ERRORS.invalidActive };
    if (body.role === undefined && body.active === undefined) return { ok: false, error: NOTHING_TO_CHANGE_MESSAGE };
    const action: AdminAction = { kind: "update", email };
    if (body.role !== undefined) action.role = body.role as Role;
    if (body.active !== undefined) action.active = body.active as boolean;
    return { ok: true, action };
  }
  if (method === "DELETE") {
    if (!email) return { ok: false, error: USER_ERRORS.invalidEmail };
    return { ok: true, action: { kind: "remove", email } };
  }
  return { ok: false, error: BAD_REQUEST_MESSAGE };
}

// Applies one action to the fresh list. The actor must still be an active admin in that list
// (an admin demoted or removed on another device cannot keep editing). Pure.
export function applyAdminAction(list: UserRecord[], action: AdminAction, actor: string): Result {
  if (findAccess(list, actor).role !== "admin") return { ok: false, error: ADMIN_ONLY_MESSAGE };
  if (action.kind === "add") return addUser(list, action.email, action.role);
  if (action.kind === "remove") return removeUser(list, action.email, actor);
  let result: Result = { ok: true, users: list };
  if (action.role !== undefined) result = setRole(result.users, action.email, action.role, actor);
  if (result.ok && action.active !== undefined) result = setActive(result.users, action.email, action.active, actor);
  return result;
}

export function ruleErrorStatus(error: string): number {
  if (error === ADMIN_ONLY_MESSAGE) return 403;
  if (error === USER_ERRORS.notFound) return 404;
  if (error === USER_ERRORS.invalidEmail || error === USER_ERRORS.invalidRole || error === USER_ERRORS.invalidActive) return 400;
  return 409;
}

function storageFailure(err: unknown, fallback: string) {
  return sharedStorageFailure("admin-users", err, CONCURRENT_EDIT_MESSAGE, fallback);
}

export async function handleAdminUsers(request: Request, method: AdminUsersMethod, store: UserStore): Promise<Response> {
  const gate = await requireAdmin(request, store);
  if (!gate.ok) return gate.response;
  const actor = gate.actor;

  if (method === "GET") {
    try {
      return json({ users: await store.list() });
    } catch (err) {
      return storageFailure(err, LOAD_FAILED_MESSAGE);
    }
  }

  // After the auth checks (an anonymous caller still gets 401), before reading the body.
  if (!isJsonContentType(request.headers.get("content-type"))) return json({ error: JSON_REQUIRED_MESSAGE }, 415);

  const body: unknown = await request.json().catch(() => undefined);
  const parsed = parseAdminUsersBody(method, body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  let result: Result;
  try {
    result = await store.mutate((list) => applyAdminAction(list, parsed.action, actor));
  } catch (err) {
    return storageFailure(err, SAVE_FAILED_MESSAGE);
  }
  if (!result.ok) return json({ error: result.error }, ruleErrorStatus(result.error));
  return json({ users: result.users });
}
