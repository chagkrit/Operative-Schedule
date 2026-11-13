// SERVER-ONLY: who is making this request, and are they on the allowlist.
//
// A deny here only rejects the current request/page render. It never signs anyone out or
// clears a session, so a transient Blob read error does not log people out (the next
// request after the list is readable again simply works).
//
// `../../auth` is imported lazily inside sessionAccess() so this module (and app/lib/calendar.ts,
// which imports it) stays loadable by the node tests: `next-auth` itself needs the Next bundler,
// `next-auth/jwt` does not.
import { getToken } from "next-auth/jwt";
import { userStore, type UserStore } from "./user-store";
import { normalizeEmail, type Role } from "./users";

export const SIGN_IN_REQUIRED_MESSAGE = "กรุณาเข้าสู่ระบบด้วยบัญชีที่ได้รับอนุญาต";

export type SessionAccess = { email: string; role: Role };
type AccessSource = Pick<UserStore, "getAccess">;

function unauthorized() {
  return Object.assign(new Error(SIGN_IN_REQUIRED_MESSAGE), { status: 401 });
}

// The verified Auth.js JWT of a route-handler request (null when absent or invalid).
export function requestToken(request: Request) {
  return getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: new URL(request.url).protocol === "https:",
  });
}

export function tokenEmail(token: { email?: unknown } | null | undefined): string {
  return typeof token?.email === "string" ? normalizeEmail(token.email) : "";
}

// {email, role} when the email is on the allowlist and active, otherwise null.
export async function emailAccess(
  email: string | null | undefined,
  store: AccessSource = userStore,
): Promise<SessionAccess | null> {
  const normalized = normalizeEmail(email || "");
  if (!normalized) return null;
  const access = await store.getAccess(normalized);
  return access.allowed && access.role ? { email: normalized, role: access.role } : null;
}

// Route handlers: the signed-in, allowed user's lower-case email; throws a 401-status error otherwise.
export async function requestUserEmail(request: Request, store: AccessSource = userStore): Promise<string> {
  const access = await emailAccess(tokenEmail(await requestToken(request)), store);
  if (!access) throw unauthorized();
  return access.email;
}

// Server components: the signed-in, allowed user, or null (caller redirects to /signin).
export async function sessionAccess(): Promise<SessionAccess | null> {
  const { auth } = await import("../../auth");
  const session = await auth();
  return emailAccess(session?.user?.email);
}
