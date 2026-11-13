# Admin User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Allowlist of Google accounts stored in Vercel Blob, managed by admins at `/admin`; record the real booker in `booked_by` and show "ลงโดย".

**Architecture:** Pure rules module (`app/lib/users.ts`) + Blob-backed store with 30 s in-memory cache (`app/lib/user-store.ts`, storage adapter injectable for tests) consulted by the Auth.js callbacks and the single API chokepoint `authorizedAccessToken` (`app/lib/calendar.ts`). Admin REST route `/api/admin/users` + page `/admin`.

**Tech Stack:** Next.js 16 (breaking changes — read `node_modules/next/dist/docs/` first, see AGENTS.md), next-auth v5 beta, `@vercel/blob`, node:test (`tests/*.test.mjs`, TS imported directly).

**Spec:** `docs/superpowers/specs/2026-11-13-admin-user-management-design.md`

## Global Constraints
- Bootstrap admin `nansurg7@gmail.com`: hardcoded, always admin+active, cannot be removed/demoted/deactivated, allowed even if Blob unreadable. Any other email: Blob unreadable ⇒ denied (fail closed).
- Seed (`{hnbcmu@gmail.com: user active}` + bootstrap admin) ONLY when the list file is missing (404), never on other errors.
- Emails lower-case; any domain; valid-format check only; unique. Last active admin cannot be removed/demoted/deactivated; an admin cannot remove/demote/deactivate themselves.
- Role values `"user" | "admin"`; `active: boolean`. Thai UI copy; match existing styling (app/globals.css, aurora.css); mobile 390px.
- inactive/removed takes effect on already-signed-in sessions within 30 s (cache TTL 30 s; admin writes invalidate the local cache).
- Secrets only via Vercel env (`BLOB_READ_WRITE_TOKEN`), never in repo. Blob must be private if SDK supports it.
- Checks before done: `npm test`, `npx tsc --noEmit`, `npx eslint auth.ts app scripts tests`. Revert `next-env.d.ts` if next rewrites it.

## Review Focus
- Removing/deactivating the signed-in admin or the last admin (rejected, message in Thai).
- Email with spaces/upper case/duplicate/invalid ("abc", "a@b") on add.
- Blob read error (non-404) for hnbcmu ⇒ denied; for nansurg7 ⇒ allowed; 404 ⇒ seeded.
- Non-admin calling `/api/admin/users` (403) and unauthenticated (401).
- Stale cache after admin write (invalidated); inactive user with a live session loses API access ≤30 s.
- Legacy bookings without `booked_by` show hnbcmu; new bookings store the session email.

### Task 1: Pure user rules
**Files:** Create `app/lib/users.ts`; Test `tests/users.test.mjs`
**Produces:**
```ts
export type Role = "user" | "admin";
export type UserRecord = { email: string; role: Role; active: boolean };
export const BOOTSTRAP_ADMIN = "nansurg7@gmail.com";
export const SEED_USERS: UserRecord[]; // bootstrap admin + hnbcmu@gmail.com user active
export function normalizeEmail(v: string): string;           // trim + lower-case
export function isValidEmail(v: string): boolean;            // normalized, single "@", dotted domain, no spaces
export function withBootstrap(list: UserRecord[]): UserRecord[]; // forces bootstrap admin active admin, dedupes
export function findAccess(list: UserRecord[], email: string): { allowed: boolean; role: Role | null };
export type Result = { ok: true; users: UserRecord[] } | { ok: false; error: string }; // error = Thai message
export function addUser(list, email, role): Result;
export function removeUser(list, email, actor): Result;
export function setRole(list, email, role, actor): Result;
export function setActive(list, email, active, actor): Result;
```
- [ ] Write failing tests covering every Review Focus line for these functions (self-removal, last admin, bootstrap protection, dup/invalid/case, findAccess inactive ⇒ not allowed, bootstrap always allowed).
- [ ] Implement; `npm test` passes; commit.

### Task 2: Blob-backed store
**Files:** Create `app/lib/user-store.ts`; Modify `package.json`/lock (`@vercel/blob`); Test `tests/user-store.test.mjs`
**Consumes:** Task 1 exports.
**Produces:**
```ts
export type UserStorage = { read(): Promise<UserRecord[] | "missing">; write(users: UserRecord[]): Promise<void> }; // read throws on non-404 errors
export function createUserStore(storage: UserStorage, now?: () => number): {
  getAccess(email: string): Promise<{ allowed: boolean; role: Role | null }>;
  list(): Promise<UserRecord[]>;
  mutate(fn: (list: UserRecord[]) => Result): Promise<Result>; // read fresh (bypass cache) → fn → write → refresh cache
};
export const userStore; // singleton using blobStorage (path "or-queue/users.json", private access)
```
- [ ] Failing tests with an in-memory adapter and fake clock: 404 ⇒ seed written; read error ⇒ non-bootstrap denied, bootstrap allowed; cache 30 s then re-read; mutate invalidates cache; failed mutate does not write.
- [ ] Add `@vercel/blob` (read its docs for private access/get/put/head 404 semantics); implement `blobStorage`; commit.

### Task 3: Enforce access + record the booker
**Files:** Modify `auth.ts`, `app/page.tsx`, `app/signin/page.tsx`, `app/api/presence/route.ts`, `app/lib/calendar.ts` (`authorizedAccessToken`, error text no longer says hnbcmu), `app/api/schedule/route.ts` (bookedByEmail from session); Create `app/lib/session.ts`; Test `tests/access-wiring.test.mjs`
**Consumes:** `userStore.getAccess`.
**Produces:** `requestUserEmail(request: Request): Promise<string>` (verified JWT email, lower-case; throws 401 like existing helper) and `sessionAccess()` for server components (`{email, role} | null`). Keep `AUTHORIZED_EMAIL` export only where still meaning the calendar owner/legacy default.
- [ ] Failing wiring tests (grep-style like tests/case-detail.test.mjs: no remaining `=== AUTHORIZED_EMAIL` auth comparisons; schedule POST uses session email; signIn callback consults userStore).
- [ ] Implement (Auth.js `signIn` + `authorized` use `getAccess`; `jwt` keeps email; every API path still goes through `authorizedAccessToken` which now checks `getAccess(token.email).allowed`); `page.tsx` passes `isAdmin` to `SchedulerApp`; commit.

### Task 4: Admin API, page, UI, "ลงโดย"
**Files:** Create `app/api/admin/users/route.ts` (GET list; POST {email, role}; PATCH {email, role?, active?}; DELETE {email}; admin-only 403, unauthenticated 401, errors as `{error: thai}` 400/409), `app/admin/page.tsx` (server: redirect non-admin to `/`), `app/admin/AdminUsers.tsx`; Modify `app/SchedulerApp.tsx` (menu link "จัดการผู้ใช้" only when `isAdmin`; Booking already has `bookedByEmail`? add to API payload + type), `app/CaseDetailDialog.tsx` ("ลงโดย" row), `app/api/schedule/route.ts` (include `bookedByEmail` per booking), css; Test `tests/admin-users.test.mjs`
**Consumes:** `userStore.list/mutate`, `addUser/removeUser/setRole/setActive`, `sessionAccess`.
- [ ] Failing tests: route enforces roles (wiring + pure), dialog label "ลงโดย", menu link gated by isAdmin.
- [ ] Implement UI: list rows (email, role select, active toggle, delete with ConfirmDialog), add form; Thai error display; commit.

### Task 5 (controller): whole-branch Opus review → fixes → Blob store + env + seed check → PR → merge → verify prod
