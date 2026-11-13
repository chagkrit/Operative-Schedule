import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "./ts-resolve.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const { encode } = await import("next-auth/jwt");
const { BlobPreconditionFailedError } = await import("@vercel/blob");
const api = await import("../app/lib/admin-users-api.ts");
const { createUserStore } = await import("../app/lib/user-store.ts");

const SECRET = "test-secret-for-admin-users-0123456789";
const COOKIE = "authjs.session-token"; // http:// URL ⇒ non-secure cookie name
const ADMIN = "nansurg7@gmail.com";
const HN = "hnbcmu@gmail.com";
const u = (email, role = "user", active = true) => ({ email, role, active });
const BASE = [u(ADMIN, "admin"), u(HN), u("boss@cmu.ac.th", "admin"), u("off@x.com", "user", false)];

// In-memory storage (no network, no Blob): `data` may be replaced between calls.
function memory(initial = BASE) {
  const state = { data: initial.map((r) => ({ ...r })), writes: 0, failWrite: null, failRead: null };
  const storage = {
    async read() {
      if (state.failRead) throw state.failRead;
      return state.data.map((r) => ({ ...r }));
    },
    async write(users) {
      if (state.failWrite) throw state.failWrite;
      state.writes += 1;
      state.data = users.map((r) => ({ ...r }));
    },
  };
  return { state, store: createUserStore(storage) };
}

async function call(store, method, { as, body, raw, contentType = "application/json" } = {}) {
  process.env.AUTH_SECRET = SECRET;
  const headers = {};
  if (contentType !== null) headers["content-type"] = contentType;
  if (as) headers.cookie = `${COOKIE}=${await encode({ token: { email: as }, secret: SECRET, salt: COOKIE })}`;
  const init = { method, headers };
  if (method === "GET") {
    // A GET carries no body.
  } else if (raw !== undefined) init.body = raw;
  else if (body !== undefined) init.body = JSON.stringify(body);
  const response = await api.handleAdminUsers(new Request("http://localhost/api/admin/users", init), method, store);
  const text = await response.text();
  return { status: response.status, cacheControl: response.headers.get("cache-control"), json: text ? JSON.parse(text) : null, text };
}

function quiet(fn) {
  const original = console.error;
  console.error = () => {};
  return fn().finally(() => {
    console.error = original;
  });
}

// ---- pure request validation ----

test("parseAdminUsersBody validates shape and types per method, with Thai 400 messages", () => {
  const p = api.parseAdminUsersBody;
  assert.deepEqual(p("POST", { email: "  New.Person@CMU.ac.th ", role: "admin" }), { ok: true, action: { kind: "add", email: "new.person@cmu.ac.th", role: "admin" } });
  assert.deepEqual(p("PATCH", { email: "A@X.com", active: false }), { ok: true, action: { kind: "update", email: "a@x.com", active: false } });
  assert.deepEqual(p("PATCH", { email: "a@x.com", role: "user", active: true }), { ok: true, action: { kind: "update", email: "a@x.com", role: "user", active: true } });
  assert.deepEqual(p("DELETE", { email: " A@X.com" }), { ok: true, action: { kind: "remove", email: "a@x.com" } });

  const bad = [
    ["POST", null],
    ["POST", "a@x.com"],
    ["POST", ["a@x.com"]],
    ["POST", {}],
    ["POST", { email: "", role: "user" }],
    ["POST", { email: "   ", role: "user" }],
    ["POST", { email: 42, role: "user" }],
    ["POST", { email: "a@x.com" }],
    ["POST", { email: "a@x.com", role: "owner" }],
    ["POST", { email: "abc", role: "user" }],
    ["POST", { email: "a@b", role: "user" }],
    ["POST", { email: "a b@x.com", role: "user" }],
    ["PATCH", { email: "a@x.com" }],
    ["PATCH", { email: "a@x.com", active: "false" }],
    ["PATCH", { email: "a@x.com", active: 0 }],
    ["PATCH", { email: "a@x.com", role: "superuser" }],
    ["PATCH", { email: "", active: true }],
    ["PATCH", { role: "user" }],
    ["DELETE", {}],
    ["DELETE", { email: "" }],
    ["DELETE", { email: null }],
    ["DELETE", { email: "x".repeat(400) + "@x.com" }],
    ["PUT", { email: "a@x.com" }],
  ];
  for (const [method, body] of bad) {
    const r = p(method, body);
    assert.equal(r.ok, false, `${method} ${JSON.stringify(body)} should be rejected`);
    assert.match(r.error, /[฀-๿]/, "Thai message");
  }
  assert.match(p("POST", { email: "abc", role: "user" }).error, /รูปแบบอีเมลไม่ถูกต้อง/);
  assert.match(p("POST", { email: "a@x.com", role: "owner" }).error, /สิทธิ์ไม่ถูกต้อง/);
  assert.match(p("PATCH", { email: "a@x.com", active: "no" }).error, /สถานะไม่ถูกต้อง/);
});

test("applyAdminAction: self-removal/demotion/deactivation and bootstrap edits are refused in Thai; a stale actor is refused", () => {
  const list = [u("a@x.com", "admin"), u("b@x.com", "admin", false), u("c@x.com")];
  const apply = api.applyAdminAction;
  assert.match(apply(list, { kind: "remove", email: "a@x.com" }, "a@x.com").error, /ลบบัญชีของตัวเองไม่ได้/);
  assert.match(apply(list, { kind: "update", email: "a@x.com", role: "user" }, "a@x.com").error, /ลดสิทธิ์ของตัวเองไม่ได้/);
  assert.match(apply(list, { kind: "update", email: "a@x.com", active: false }, "a@x.com").error, /ปิดการใช้งานบัญชีของตัวเองไม่ได้/);
  // An actor who is no longer an active admin in the fresh list is refused (403 at the route).
  assert.equal(apply(list, { kind: "remove", email: "c@x.com" }, "c@x.com").error, api.ADMIN_ONLY_MESSAGE);
  assert.equal(apply(list, { kind: "remove", email: "c@x.com" }, "b@x.com").error, api.ADMIN_ONLY_MESSAGE);
  // The acting admin must still be an active admin in the fresh list, so an admin demoted on another
  // device cannot keep editing. (The last-active-admin guard itself is covered in users.test.mjs: with
  // the actor check and the always-present bootstrap admin it cannot be reached through this API.)
  const two = [u("a@x.com", "admin"), u("z@x.com", "admin")];
  const demoteBoth = apply(apply(two, { kind: "update", email: "z@x.com", role: "user" }, "a@x.com").users, { kind: "remove", email: "a@x.com" }, "z@x.com");
  assert.equal(demoteBoth.error, api.ADMIN_ONLY_MESSAGE);
  // Combined PATCH applies both changes or neither.
  const both = apply(BASE, { kind: "update", email: HN, role: "admin", active: false }, ADMIN);
  assert.deepEqual(both.users.find((r) => r.email === HN), u(HN, "admin", false));
  const half = apply(BASE, { kind: "update", email: ADMIN, role: "admin", active: false }, "boss@cmu.ac.th");
  assert.equal(half.ok, false);
  assert.match(half.error, /ผู้ดูแลระบบหลัก/);
});

test("rule errors map to sensible HTTP statuses", () => {
  assert.equal(api.ruleErrorStatus("รูปแบบอีเมลไม่ถูกต้อง"), 400);
  assert.equal(api.ruleErrorStatus("ไม่พบอีเมลนี้ในรายชื่อ"), 404);
  assert.equal(api.ruleErrorStatus("มีอีเมลนี้ในรายชื่อแล้ว"), 409);
  assert.equal(api.ruleErrorStatus("ลบบัญชีของตัวเองไม่ได้"), 409);
  assert.equal(api.ruleErrorStatus("ต้องมีผู้ดูแลระบบที่ใช้งานอยู่อย่างน้อย 1 คน"), 409);
  assert.equal(api.ruleErrorStatus(api.ADMIN_ONLY_MESSAGE), 403);
});

// ---- the handler with a real Auth.js JWT and an in-memory store ----

test("unauthenticated, unknown or inactive → 401, active non-admin → 403, on every method, never writing", async () => {
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    const { state, store } = memory();
    const body = { email: "new@x.com", role: "user" };
    const anon = await call(store, method, { body });
    assert.equal(anon.status, 401, method);
    assert.match(anon.json.error, /เข้าสู่ระบบ/);
    assert.equal(anon.cacheControl, "no-store");
    const stranger = await call(store, method, { as: "stranger@x.com", body });
    assert.equal(stranger.status, 401, method);
    const inactive = await call(store, method, { as: "off@x.com", body });
    assert.equal(inactive.status, 401, method);
    assert.match(inactive.json.error, /เข้าสู่ระบบ/);
    assert.equal(inactive.cacheControl, "no-store");
    const user = await call(store, method, { as: HN, body });
    assert.equal(user.status, 403, method);
    assert.equal(user.json.error, api.ADMIN_ONLY_MESSAGE);
    assert.equal(user.cacheControl, "no-store");
    assert.equal(state.writes, 0);
  }
});

test("GET lists users for an admin, no-store", async () => {
  const { store } = memory();
  const r = await call(store, "GET", { as: "Boss@CMU.ac.th" });
  assert.equal(r.status, 200);
  assert.equal(r.cacheControl, "no-store");
  assert.deepEqual(r.json.users, BASE);
});

test("POST adds a trimmed, lower-cased user; duplicates (any case) 409; invalid 400; bad JSON 400", async () => {
  const { state, store } = memory();
  const ok = await call(store, "POST", { as: ADMIN, body: { email: "  New.Person@CMU.ac.th ", role: "user" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.users.at(-1), u("new.person@cmu.ac.th"));
  assert.deepEqual(state.data.at(-1), u("new.person@cmu.ac.th"));

  const dup = await call(store, "POST", { as: ADMIN, body: { email: " HNBCMU@Gmail.com ", role: "admin" } });
  assert.equal(dup.status, 409);
  assert.match(dup.json.error, /มีอีเมลนี้ในรายชื่อแล้ว/);

  for (const email of ["abc", "a@b", "a b@x.com", "", "​z@x.com"]) {
    const bad = await call(store, "POST", { as: ADMIN, body: { email, role: "user" } });
    assert.equal(bad.status, 400, JSON.stringify(email));
    assert.match(bad.json.error, /รูปแบบอีเมลไม่ถูกต้อง/);
  }
  const notJson = await call(store, "POST", { as: ADMIN, raw: "{not json" });
  assert.equal(notJson.status, 400);
  assert.match(notJson.json.error, /[฀-๿]/);
  const writes = state.writes;
  await call(store, "POST", { as: ADMIN, body: { email: "x@x.com", role: "root" } });
  assert.equal(state.writes, writes, "a rejected request writes nothing");
});

test("POST/PATCH/DELETE need a JSON Content-Type (415, Thai, no-store) after the 401/403 checks; GET does not", async () => {
  const bodies = { POST: { email: "new@x.com", role: "user" }, PATCH: { email: HN, active: false }, DELETE: { email: HN } };
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const { state, store } = memory();
    const body = bodies[method];
    const plain = await call(store, method, { as: ADMIN, body, contentType: "text/plain" });
    assert.equal(plain.status, 415, `${method} text/plain`);
    assert.match(plain.json.error, /[฀-๿]/);
    assert.equal(plain.cacheControl, "no-store");
    // A Uint8Array body gets no default content-type, so the header is really absent.
    const missing = await call(store, method, { as: ADMIN, raw: new TextEncoder().encode(JSON.stringify(body)), contentType: null });
    assert.equal(missing.status, 415, `${method} no content-type`);
    assert.equal(missing.cacheControl, "no-store");
    const formish = await call(store, method, { as: ADMIN, body, contentType: "application/jsonx" });
    assert.equal(formish.status, 415, `${method} application/jsonx`);
    assert.equal(state.writes, 0, "a 415 writes nothing");
    // Auth comes first: anonymous → 401, active non-admin → 403, even with a wrong type.
    assert.equal((await call(store, method, { body, contentType: "text/plain" })).status, 401);
    assert.equal((await call(store, method, { as: HN, body, contentType: "text/plain" })).status, 403);
    // A JSON type (any case, with a charset) is unchanged.
    const ok = await call(store, method, { as: ADMIN, body, contentType: "Application/JSON; charset=utf-8" });
    assert.equal(ok.status, 200, `${method} JSON with charset`);
  }
  const { store } = memory();
  const get = await call(store, "GET", { as: ADMIN, contentType: null });
  assert.equal(get.status, 200);
});

test("DELETE/PATCH on yourself or the bootstrap admin are refused with Thai 409; unknown email 404", async () => {
  const { state, store } = memory();
  const cases = [
    ["DELETE", "boss@cmu.ac.th", { email: "BOSS@cmu.ac.th" }, /ลบบัญชีของตัวเองไม่ได้/],
    ["PATCH", "boss@cmu.ac.th", { email: "boss@cmu.ac.th", role: "user" }, /ลดสิทธิ์ของตัวเองไม่ได้/],
    ["PATCH", "boss@cmu.ac.th", { email: "boss@cmu.ac.th", active: false }, /ปิดการใช้งานบัญชีของตัวเองไม่ได้/],
    ["DELETE", "boss@cmu.ac.th", { email: ADMIN }, /ผู้ดูแลระบบหลัก/],
    ["PATCH", "boss@cmu.ac.th", { email: ADMIN, role: "user" }, /ผู้ดูแลระบบหลัก/],
    ["PATCH", "boss@cmu.ac.th", { email: ADMIN, active: false }, /ผู้ดูแลระบบหลัก/],
    ["DELETE", ADMIN, { email: ADMIN }, /ผู้ดูแลระบบหลัก/],
  ];
  for (const [method, as, body, pattern] of cases) {
    const r = await call(store, method, { as, body });
    assert.equal(r.status, 409, `${method} ${JSON.stringify(body)}`);
    assert.match(r.json.error, pattern);
  }
  const ghost = await call(store, "DELETE", { as: ADMIN, body: { email: "ghost@x.com" } });
  assert.equal(ghost.status, 404);
  assert.match(ghost.json.error, /ไม่พบอีเมลนี้ในรายชื่อ/);
  assert.equal(state.writes, 0);
});

test("PATCH and DELETE change other users and answer with the saved list", async () => {
  const { state, store } = memory();
  const off = await call(store, "PATCH", { as: ADMIN, body: { email: "HNBCMU@gmail.com", active: false } });
  assert.equal(off.status, 200);
  assert.deepEqual(off.json.users.find((r) => r.email === HN), u(HN, "user", false));
  const promote = await call(store, "PATCH", { as: ADMIN, body: { email: "off@x.com", role: "admin", active: true } });
  assert.deepEqual(promote.json.users.find((r) => r.email === "off@x.com"), u("off@x.com", "admin"));
  const removed = await call(store, "DELETE", { as: ADMIN, body: { email: "boss@cmu.ac.th" } });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.users.some((r) => r.email === "boss@cmu.ac.th"), false);
  assert.deepEqual(removed.json.users, state.data);
});

test("responses come from mutate's fresh read, never from a stale cache or a follow-up list()", async () => {
  const { state, store } = memory();
  await store.getAccess(ADMIN); // primes the 30 s cache with BASE
  state.data = [...state.data, u("other-device@x.com")]; // another instance wrote meanwhile
  const spy = { ...store, list: async () => { throw new Error("list() must not be used for mutation responses"); } };
  const r = await call(spy, "POST", { as: ADMIN, body: { email: "late@x.com", role: "user" } });
  assert.equal(r.status, 200);
  assert.ok(r.json.users.some((x) => x.email === "other-device@x.com"), "kept the other instance's write");
  assert.ok(r.json.users.some((x) => x.email === "late@x.com"));
});

test("storage failures: etag conflict → 409, anything else → 500; never leaks internals", async () => {
  await quiet(async () => {
    const { state, store } = memory();
    state.failWrite = new BlobPreconditionFailedError();
    const conflict = await call(store, "POST", { as: ADMIN, body: { email: "a@x.com", role: "user" } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error, api.CONCURRENT_EDIT_MESSAGE);
    assert.equal(conflict.cacheControl, "no-store");

    state.failWrite = new Error("Vercel Blob: secret token=abc /internal/path");
    const broken = await call(store, "DELETE", { as: ADMIN, body: { email: HN } });
    assert.equal(broken.status, 500);
    assert.match(broken.json.error, /[฀-๿]/);
    assert.doesNotMatch(broken.text, /secret|token|internal|Vercel/i);

    state.failWrite = null;
    state.failRead = new Error("blob 503 details");
    const unreadable = await call(store, "GET", { as: ADMIN });
    assert.equal(unreadable.status, 500);
    assert.doesNotMatch(unreadable.text, /503|details/);
  });
});

// ---- wiring ----

test("route binds the shared store, every verb, and opts out of caching", async () => {
  const route = await read("app/api/admin/users/route.ts");
  assert.match(route, /import \{ userStore \} from "\.\.\/\.\.\/\.\.\/lib\/user-store"/);
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    assert.match(route, new RegExp(`export async function ${method}\\(request: Request\\) \\{\\s*return handleAdminUsers\\(request, "${method}", userStore\\);`));
  }
  assert.match(route, /export const dynamic = "force-dynamic";/);
  const lib = await read("app/lib/admin-users-api.ts");
  assert.match(lib, /await requestUserEmail\(request, store\)/);
  assert.match(lib, /store\.mutate\(/);
  assert.match(lib, /"Cache-Control": "no-store"/);
});

test("/admin page: signed-out → /signin, non-admin → /, list errors render a Thai panel", async () => {
  const page = await read("app/admin/page.tsx");
  assert.match(page, /const access = await sessionAccess\(\);\s*if \(!access\) redirect\("\/signin"\);\s*if \(access\.role !== "admin"\) redirect\("\/"\);/);
  // redirect() throws NEXT_REDIRECT: both calls sit before the try around list().
  assert.ok(page.indexOf('redirect("/")') < page.indexOf("try {"));
  assert.match(page, /await userStore\.list\(\)/);
  assert.match(page, /role="alert"/);
  assert.match(page, /<AdminUsers initialUsers=\{users\} currentEmail=\{access\.email\} \/>/);
  assert.match(page, /href="\/"/);
});

test("AdminUsers renders from API responses, confirms deletes, locks bootstrap and self, announces results", async () => {
  const ui = await read("app/admin/AdminUsers.tsx");
  assert.match(ui, /^"use client";/);
  assert.doesNotMatch(ui, /user-store|admin-users-api|@vercel\/blob/, "client must not import server modules");
  assert.match(ui, /import ConfirmDialog from "\.\.\/ConfirmDialog"/);
  assert.match(ui, /fetch\("\/api\/admin\/users"/);
  assert.match(ui, /setUsers\(data\.users as UserRecord\[\]\)/);
  assert.match(ui, /!Array\.isArray\(data\.users\)/);
  assert.match(ui, /BOOTSTRAP_ADMIN/);
  assert.match(ui, /aria-live="polite"/);
  assert.match(ui, /ใช้งาน/);
  assert.match(ui, /ปิดชั่วคราว/);
  assert.match(ui, /disabled=\{locked \|\| busy\}/);
  assert.match(ui, /event\.key === "Escape"/);
  // The switch's name is static; aria-checked carries the on/off state.
  assert.match(ui, /role="switch"\s+aria-checked=\{user\.active\}\s+aria-label=\{`ใช้งานบัญชี \$\{user\.email\}`\}/);
  assert.doesNotMatch(ui, /สถานะของ \$\{user\.email\}/);
});

test("menu shows จัดการผู้ใช้ only to admins", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /export default function SchedulerApp\(\{ authorizedEmail, isAdmin \}/);
  assert.match(app, /\{isAdmin && <Link className="admin-link" href="\/admin"[^\n]*>จัดการผู้ใช้<\/Link>\}/);
  assert.equal((app.match(/จัดการผู้ใช้/g) || []).length, 1);
  const css = await read("app/mobile-shell.css");
  assert.match(css, /\.topbar \.topbar-actions \.admin-link/);
});

test("/signin explains a denied account without signing it out", async () => {
  const signin = await read("app/signin/page.tsx");
  assert.match(signin, /if \(await sessionAccess\(\)\) redirect\("\/"\);/);
  assert.match(signin, /await sessionEmail\(\)/);
  assert.match(signin, /error === "AccessDenied"/);
  // Also covers a temporary outage of the permission check (the store fails closed).
  assert.ok(signin.includes("บัญชีนี้ยังไม่ได้รับอนุญาต ถูกปิดการใช้งาน หรือระบบตรวจสิทธิ์ขัดข้องชั่วคราว กรุณาลองใหม่หรือติดต่อผู้ดูแลระบบ"));
  assert.ok(signin.indexOf("signin-denied") < signin.indexOf("google-button"), "notice above the sign-in button");
  assert.doesNotMatch(signin, /signOut/);
  const session = await read("app/lib/session.ts");
  assert.match(session, /export async function sessionEmail\(\)/);
});

test("new admin classes meet the phone 12px text and 44px target floors", async () => {
  const css = await read("app/mobile-shell.css");
  const polish = css.slice(css.indexOf("Phone polish"));
  const targets = polish.slice(polish.indexOf("/* Touch targets: 44px */"), polish.indexOf("min-height: 44px;"));
  for (const cls of [".admin-link", ".admin-back", ".admin-reload", ".admin-row button", ".admin-add-form button"]) {
    assert.ok(targets.includes(cls), `${cls} in touch-target list`);
  }
  const floor = polish.slice(polish.indexOf("/* Text floor: 12px */"), polish.indexOf("font-size: 12px;"));
  for (const cls of [".admin-note", ".admin-summary"]) assert.ok(floor.includes(cls), `${cls} in text floor`);
  const inputs = polish.slice(polish.indexOf("/* Inputs: 44px tall"));
  // Selects and inputs stay 16px so iOS Safari does not zoom on focus.
  for (const cls of [".admin-add-form input", ".admin-add-form select", ".admin-row select"]) {
    assert.ok(inputs.slice(0, inputs.indexOf("font-size: 16px;")).includes(cls), `${cls} in 16px input list`);
  }
});
