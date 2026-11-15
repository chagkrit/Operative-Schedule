import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "./ts-resolve.mjs";

const { encode } = await import("next-auth/jwt");
const { BlobPreconditionFailedError } = await import("@vercel/blob");
const api = await import("../app/lib/admin-calendar-api.ts");
const { createUserStore } = await import("../app/lib/user-store.ts");
const { createCalendarSettingsStore } = await import("../app/lib/calendar-settings-store.ts");
const { sealToken, openToken } = await import("../app/lib/token-seal.ts");

const SECRET = "test-secret-for-admin-calendar-0123456789";
const COOKIE = "authjs.session-token";
const ADMIN = "nansurg7@gmail.com";
const KEY = Buffer.alloc(32, 7).toString("base64");
const u = (email, role = "user", active = true) => ({ email, role, active });
const USERS = [u(ADMIN, "admin"), u("hnbcmu@gmail.com"), u("view@cmu.ac.th", "viewer"), u("off@x.com", "user", false)];

const MASTER_TOKEN = "SYNTH-MASTER-REFRESH-TOKEN-aaaa";
const NEW_TOKEN = "SYNTH-NEW-REFRESH-TOKEN-bbbb";
const target = (email, calendarId, token) => ({ email, calendarId, sealedRefreshToken: sealToken(token, KEY) });
const SETTINGS = () => ({ master: target("hnbcmu@gmail.com", "hnbcmu@gmail.com", MASTER_TOKEN) });

function memorySettings(initial) {
  const state = { data: initial === undefined ? "missing" : structuredClone(initial), reads: 0, writes: 0, failRead: null, failWrite: null };
  const store = createCalendarSettingsStore({
    async read() {
      state.reads += 1;
      if (state.failRead) throw state.failRead;
      return state.data === "missing" ? "missing" : structuredClone(state.data);
    },
    async write(s) {
      if (state.failWrite) throw state.failWrite;
      state.writes += 1;
      state.data = structuredClone(s);
    },
  });
  return { state, store };
}

function harness({ settings, key = KEY, verify, env = {} } = {}) {
  if (key === null) key = undefined; // pass null for "no key" (undefined would pick the default)
  const mem = memorySettings(settings);
  const calls = [];
  const verifyAccount = async (a) => {
    calls.push({ ...a });
    return verify ? verify(a) : { email: "new@gmail.com" };
  };
  const deps = {
    users: createUserStore({ async read() { return USERS.map((r) => ({ ...r })); }, async write() {} }),
    settings: mem.store,
    env: { AUTHORIZED_EMAIL: "hnbcmu@gmail.com", CALENDAR_SETTINGS_KEY: key, ...env },
    verifyAccount,
    now: () => 1_000_000,
  };
  return { ...mem, calls, deps };
}

async function call(h, method, { as, body, raw, contentType = "application/json" } = {}) {
  process.env.AUTH_SECRET = SECRET;
  const headers = {};
  if (contentType !== null) headers["content-type"] = contentType;
  if (as) headers.cookie = `${COOKIE}=${await encode({ token: { email: as }, secret: SECRET, salt: COOKIE })}`;
  const init = { method, headers };
  if (method !== "GET") init.body = raw !== undefined ? raw : JSON.stringify(body);
  const response = await api.handleAdminCalendar(new Request("http://localhost/api/admin/calendar", init), method, h.deps);
  const text = await response.text();
  return { status: response.status, cacheControl: response.headers.get("cache-control"), json: text ? JSON.parse(text) : null, text };
}

async function spyConsole(fn) {
  const lines = [];
  const saved = {};
  for (const k of ["log", "error", "warn", "info", "debug"]) {
    saved[k] = console[k];
    console[k] = (...args) => lines.push(args.map(String).join(" "));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join("\n");
}

const CONNECT = { action: "connect", email: "New@Gmail.com", calendarId: "cal-new@group.calendar.google.com", refreshToken: NEW_TOKEN };

test("401 when not signed in or not allowed, with zero settings reads", async () => {
  const h = harness({ settings: SETTINGS() });
  for (const method of ["GET", "POST"]) {
    for (const as of [undefined, "stranger@gmail.com", "off@x.com"]) {
      const r = await call(h, method, { as, body: CONNECT });
      assert.equal(r.status, 401);
      assert.equal(r.json.error, "กรุณาเข้าสู่ระบบด้วยบัญชีที่ได้รับอนุญาต");
    }
  }
  assert.equal(h.state.reads, 0);
  assert.equal(h.calls.length, 0);
});

test("403 for user and viewer with ZERO settings reads and ZERO verifyAccount calls", async () => {
  const h = harness({ settings: SETTINGS() });
  for (const as of ["hnbcmu@gmail.com", "view@cmu.ac.th"]) {
    for (const method of ["GET", "POST"]) {
      const r = await call(h, method, { as, body: CONNECT });
      assert.equal(r.status, 403);
      assert.equal(r.json.error, "เฉพาะผู้ดูแลระบบเท่านั้น");
    }
  }
  assert.equal(h.state.reads, 0);
  assert.equal(h.state.writes, 0);
  assert.equal(h.calls.length, 0);
});

test("GET as admin returns only emails, ids and flags (settings source)", async () => {
  const settings = { ...SETTINGS(), candidate: target("new@gmail.com", "cand-id", NEW_TOKEN), previousMaster: target("old@gmail.com", "old-id", "SYNTH-OLD-TOKEN-cccc"), lock: { since: 1_000_000 - 1000, by: ADMIN } };
  const h = harness({ settings });
  const r = await call(h, "GET", { as: ADMIN });
  assert.equal(r.status, 200);
  assert.equal(r.cacheControl, "no-store");
  assert.deepEqual(r.json, {
    master: { email: "hnbcmu@gmail.com", calendarId: "hnbcmu@gmail.com", source: "settings" },
    candidate: { email: "new@gmail.com", calendarId: "cand-id" },
    previousMaster: { email: "old@gmail.com", calendarId: "old-id" },
    locked: true,
    keyConfigured: true,
  });
  for (const t of [MASTER_TOKEN, NEW_TOKEN, "SYNTH-OLD-TOKEN-cccc", "v1.", "sealed"]) assert.ok(!r.text.includes(t), t);
  assert.equal(h.calls.length, 0);
});

test("GET with no settings file shows the env master, keyConfigured false without a key, expired lock is not locked", async () => {
  const h = harness({ key: null, env: { GOOGLE_CALENDAR_ID: "env-cal@group.calendar.google.com" } });
  const r = await call(h, "GET", { as: ADMIN });
  assert.deepEqual(r.json, { master: { email: "hnbcmu@gmail.com", calendarId: "env-cal@group.calendar.google.com", source: "env" }, locked: false, keyConfigured: false });
  const h2 = harness({ env: {} });
  assert.equal((await call(h2, "GET", { as: ADMIN })).json.master.calendarId, "hnbcmu@gmail.com");
  const h3 = harness({ settings: { ...SETTINGS(), lock: { since: 1_000_000 - 21 * 60_000, by: ADMIN } } });
  assert.equal((await call(h3, "GET", { as: ADMIN })).json.locked, false);
});

test("GET storage failure is a fixed Thai 500 with no underlying message", async () => {
  const h = harness({ settings: SETTINGS() });
  h.state.failRead = new Error("blob secret path SYNTH-LEAK");
  const out = await spyConsole(async () => {
    const r = await call(h, "GET", { as: ADMIN });
    assert.equal(r.status, 500);
    assert.ok(!r.text.includes("SYNTH-LEAK"));
  });
  assert.ok(!out.includes("SYNTH-LEAK"));
});

test("connect happy path stores a sealed candidate that opens to the submitted token, returns the GET shape", async () => {
  const h = harness({ settings: SETTINGS() });
  const out = await spyConsole(async () => {
    const r = await call(h, "POST", { as: ADMIN, body: CONNECT });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      master: { email: "hnbcmu@gmail.com", calendarId: "hnbcmu@gmail.com", source: "settings" },
      candidate: { email: "new@gmail.com", calendarId: "cal-new@group.calendar.google.com" },
      locked: false,
      keyConfigured: true,
    });
    assert.ok(!r.text.includes(NEW_TOKEN));
  });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], { refreshToken: NEW_TOKEN, calendarId: "cal-new@group.calendar.google.com" });
  const saved = h.state.data.candidate;
  assert.equal(saved.email, "new@gmail.com");
  assert.notEqual(saved.sealedRefreshToken, NEW_TOKEN);
  assert.equal(openToken(saved.sealedRefreshToken, KEY), NEW_TOKEN);
  assert.equal(openToken(h.state.data.master.sealedRefreshToken, KEY), MASTER_TOKEN);
  assert.ok(!out.includes(NEW_TOKEN) && !out.includes(MASTER_TOKEN));
});

test("connect replaces an earlier candidate; connect with no settings file seeds the master from env", async () => {
  const h = harness({ settings: { ...SETTINGS(), candidate: target("x@y.com", "x", "SYNTH-OLD-CAND-dddd") } });
  assert.equal((await call(h, "POST", { as: ADMIN, body: CONNECT })).status, 200);
  assert.equal(h.state.data.candidate.email, "new@gmail.com");

  const h2 = harness({ env: { GOOGLE_REFRESH_TOKEN: MASTER_TOKEN } });
  const r = await call(h2, "POST", { as: ADMIN, body: CONNECT });
  assert.equal(r.status, 200);
  assert.equal(r.json.master.source, "settings");
  assert.equal(h2.state.data.master.email, "hnbcmu@gmail.com");
  assert.equal(openToken(h2.state.data.master.sealedRefreshToken, KEY), MASTER_TOKEN);

  const h3 = harness({});
  const r3 = await call(h3, "POST", { as: ADMIN, body: CONNECT });
  assert.equal(r3.status, 409);
  assert.equal(h3.state.writes, 0);
});

test("connect is refused with 409 while a switch lock is active", async () => {
  const h = harness({ settings: { ...SETTINGS(), lock: { since: 1_000_000 - 1000, by: ADMIN } } });
  const r = await call(h, "POST", { as: ADMIN, body: CONNECT });
  assert.equal(r.status, 409);
  assert.equal(h.state.writes, 0);
});

test("email mismatch is 400 with the exact Thai message and nothing is stored", async () => {
  const h = harness({ settings: SETTINGS(), verify: () => ({ email: "other@gmail.com" }) });
  const r = await call(h, "POST", { as: ADMIN, body: CONNECT });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "บัญชี Google ของ token ไม่ตรงกับอีเมลที่กรอก");
  assert.equal(h.state.writes, 0);
  // verifier returning the email in another case still matches
  const h2 = harness({ settings: SETTINGS(), verify: () => ({ email: "NEW@Gmail.COM" }) });
  assert.equal((await call(h2, "POST", { as: ADMIN, body: CONNECT })).status, 200);
});

test("verifyAccount failure is a fixed 400 that never echoes the underlying error or token", async () => {
  const h = harness({ settings: SETTINGS(), verify: () => { throw new Error(`google said ${NEW_TOKEN}`); } });
  const out = await spyConsole(async () => {
    const r = await call(h, "POST", { as: ADMIN, body: CONNECT });
    assert.equal(r.status, 400);
    assert.ok(!r.text.includes(NEW_TOKEN));
  });
  assert.ok(!out.includes(NEW_TOKEN));
  assert.equal(h.state.writes, 0);
});

test("missing or malformed key is 503 with the exact message, before any Google call", async () => {
  for (const key of [null, "", "not-a-32-byte-key"]) {
    const h = harness({ settings: SETTINGS(), key });
    const r = await call(h, "POST", { as: ADMIN, body: CONNECT });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "ยังไม่ได้ตั้งค่า CALENDAR_SETTINGS_KEY");
    assert.equal(h.calls.length, 0);
  }
});

test("non-JSON content type is 415 (after auth), bad bodies and unknown actions are 400", async () => {
  const h = harness({ settings: SETTINGS() });
  assert.equal((await call(h, "POST", { as: ADMIN, body: CONNECT, contentType: "text/plain" })).status, 415);
  assert.equal((await call(h, "POST", { as: ADMIN, body: CONNECT, contentType: null })).status, 415);
  assert.equal((await call(h, "POST", { body: CONNECT, contentType: "text/plain" })).status, 401);
  assert.equal((await call(h, "POST", { as: "hnbcmu@gmail.com", body: CONNECT, contentType: "text/plain" })).status, 403);
  assert.equal((await call(h, "POST", { as: ADMIN, raw: "{not json" })).status, 400);
  assert.equal((await call(h, "POST", { as: ADMIN, body: null })).status, 400);
  assert.equal((await call(h, "POST", { as: ADMIN, body: { ...CONNECT, action: "nope" } })).status, 400);
  assert.equal((await call(h, "POST", { as: ADMIN, body: { email: CONNECT.email } })).status, 400);
  for (const bad of [{ email: "abc" }, { calendarId: "has space" }, { calendarId: "" }, { refreshToken: "" }, { refreshToken: "x".repeat(3000) }]) {
    const r = await call(h, "POST", { as: ADMIN, body: { ...CONNECT, ...bad } });
    assert.equal(r.status, 400);
    assert.ok(!r.text.includes(NEW_TOKEN));
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.writes, 0);
});

test("storage failures map to 409 (concurrent edit) and 500 with fixed Thai text", async () => {
  const h = harness({ settings: SETTINGS() });
  h.state.failWrite = new BlobPreconditionFailedError();
  const r = await call(h, "POST", { as: ADMIN, body: CONNECT });
  assert.equal(r.status, 409);
  h.state.failWrite = new Error(`boom ${NEW_TOKEN}`);
  const out = await spyConsole(async () => {
    const r2 = await call(h, "POST", { as: ADMIN, body: CONNECT });
    assert.equal(r2.status, 500);
    assert.ok(!r2.text.includes(NEW_TOKEN));
  });
  assert.ok(!out.includes(NEW_TOKEN));
});

test("handler source: admin check precedes any settings or Google access", async () => {
  const src = await readFile(new URL("../app/lib/admin-calendar-api.ts", import.meta.url), "utf8");
  const start = src.indexOf("export async function handleAdminCalendar");
  const fn = src.slice(start, src.indexOf("// ---- production", start));
  const admin = fn.indexOf('role !== "admin"');
  assert.ok(admin !== -1);
  for (const work of ["deps.settings", "POST_ACTIONS[", "request.json("]) {
    const at = fn.indexOf(work);
    assert.ok(at !== -1 && admin < at, `${work} must come after the admin check`);
  }
  // Google is reachable only through the POST dispatcher, never directly from the handler.
  assert.ok(!fn.includes("verifyAccount"));
});
