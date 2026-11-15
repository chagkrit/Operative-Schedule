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
    async remove() {
      state.removes = (state.removes ?? 0) + 1;
      state.data = "missing";
    },
  });
  return { state, store };
}

// In-memory Google calendars keyed by calendar id (synthetic events only).
function fakeCalendars(initial = {}) {
  const cals = new Map(Object.entries(initial).map(([id, events]) => [id, new Map(events.map((e) => [e.id, structuredClone(e)]))]));
  const made = [];
  const makeClient = ({ calendarId, refreshToken }) => {
    made.push({ calendarId, refreshToken });
    if (!cals.has(calendarId)) cals.set(calendarId, new Map());
    const events = cals.get(calendarId);
    return {
      async listEvents() {
        return [...events.values()].map((e) => structuredClone(e));
      },
      async upsertEvent(e) {
        const result = events.has(e.id) ? "updated" : "created";
        events.set(e.id, structuredClone(e));
        return result;
      },
    };
  };
  return { cals, made, makeClient };
}

function harness({ settings, key = KEY, verify, env = {}, calendars } = {}) {
  if (key === null) key = undefined; // pass null for "no key" (undefined would pick the default)
  const mem = memorySettings(settings);
  const google = fakeCalendars(calendars);
  const sleeps = [];
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
    makeClient: google.makeClient,
    sleep: async (ms) => { sleeps.push(ms); },
  };
  return { ...mem, calls, deps, google, sleeps };
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
    lockedSince: 1_000_000 - 1000,
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

test("connect replaces an earlier candidate; with no settings file it creates { candidate } only (no master seeded)", async () => {
  const h = harness({ settings: { ...SETTINGS(), candidate: target("x@y.com", "x", "SYNTH-OLD-CAND-dddd") } });
  assert.equal((await call(h, "POST", { as: ADMIN, body: CONNECT })).status, 200);
  assert.equal(h.state.data.candidate.email, "new@gmail.com");

  const h2 = harness({ env: { GOOGLE_REFRESH_TOKEN: MASTER_TOKEN, GOOGLE_CALENDAR_ID: "env-cal" } });
  const r = await call(h2, "POST", { as: ADMIN, body: CONNECT });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    master: { email: "hnbcmu@gmail.com", calendarId: "env-cal", source: "env" },
    candidate: { email: "new@gmail.com", calendarId: "cal-new@group.calendar.google.com" },
    locked: false,
    keyConfigured: true,
  });
  assert.deepEqual(Object.keys(h2.state.data), ["candidate"]);
  assert.equal(openToken(h2.state.data.candidate.sealedRefreshToken, KEY), NEW_TOKEN);
  assert.ok(!r.text.includes(MASTER_TOKEN));

  // works with no env refresh token at all
  const h3 = harness({});
  assert.equal((await call(h3, "POST", { as: ADMIN, body: CONNECT })).status, 200);
  assert.deepEqual(Object.keys(h3.state.data), ["candidate"]);
});

test("GET with a master-less settings file reports the env master plus the candidate", async () => {
  const h = harness({ settings: { candidate: target("new@gmail.com", "cand-id", NEW_TOKEN), lock: { since: 1_000_000 - 1000, by: ADMIN } } });
  const r = await call(h, "GET", { as: ADMIN });
  assert.deepEqual(r.json, {
    master: { email: "hnbcmu@gmail.com", calendarId: "hnbcmu@gmail.com", source: "env" },
    candidate: { email: "new@gmail.com", calendarId: "cand-id" },
    locked: true,
    lockedSince: 1_000_000 - 1000,
    keyConfigured: true,
  });
  assert.ok(!r.text.includes(NEW_TOKEN));
});

test("production verifyGoogleAccount probes events.list (calendar.events scope), never a bare /calendars/{id}", async () => {
  const idToken = `h.${Buffer.from(JSON.stringify({ email: "New@Gmail.com", email_verified: true })).toString("base64url")}.s`;
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "SYNTH-ACCESS", id_token: idToken });
    }
    return Response.json({ items: [] });
  };
  const out = await api.verifyGoogleAccount(
    { refreshToken: NEW_TOKEN, calendarId: "cal new@group.calendar.google.com" },
    { fetch: fakeFetch, clientId: "cid", clientSecret: "csecret" },
  );
  assert.deepEqual(out, { email: "new@gmail.com" });
  assert.equal(seen.length, 2);
  const body = new URLSearchParams(String(seen[0].init.body));
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), NEW_TOKEN);
  assert.equal(seen[1].url, "https://www.googleapis.com/calendar/v3/calendars/cal%20new%40group.calendar.google.com/events?maxResults=1");
  assert.equal(seen[1].init.headers.authorization, "Bearer SYNTH-ACCESS");
  assert.ok(!seen.some((c) => /\/calendars\/[^/?]+$/.test(c.url)));
  // a calendar the token cannot read fails closed
  const denied = async (url) => (String(url).includes("oauth2") ? Response.json({ access_token: "a", id_token: idToken }) : new Response("{}", { status: 403 }));
  await assert.rejects(api.verifyGoogleAccount({ refreshToken: NEW_TOKEN, calendarId: "c" }, { fetch: denied, clientId: "cid", clientSecret: "s" }));
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
  const admin = fn.indexOf("await requireAdmin(");
  assert.ok(admin !== -1);
  for (const work of ["deps.settings", "POST_ACTIONS[", "request.json("]) {
    const at = fn.indexOf(work);
    assert.ok(at !== -1 && admin < at, `${work} must come after the admin check`);
  }
  // Google is reachable only through the POST dispatcher, never directly from the handler.
  assert.ok(!fn.includes("verifyAccount"));
});

// ---- preview / switch / clearLock -------------------------------------------------
const EV = {
  booking: { id: "bk0001aa", summary: "SYNTH-SUMMARY booking", start: { dateTime: "2026-12-01T08:00:00+07:00" }, end: { dateTime: "2026-12-01T09:00:00+07:00" }, extendedProperties: { private: { or_queue: "booking", queue_type: "OR17", hn: "SYNTH-HN-9" } } },
  extra: { id: "ea0001aa", start: { date: "2027-01-04" }, end: { date: "2027-01-05" }, extendedProperties: { private: { or_queue: "extra_day" } } },
  personal: { id: "pe0001aa", summary: "Lunch", start: { date: "2026-12-03" }, end: { date: "2026-12-04" } },
};
const CAND = () => target("new@gmail.com", "cal-new@group.calendar.google.com", NEW_TOKEN);
const SRC = () => [EV.booking, EV.extra, EV.personal];

test("preview without a candidate is 409 with the exact Thai message and no Google client", async () => {
  for (const settings of [undefined, SETTINGS()]) {
    const h = harness({ settings });
    const r = await call(h, "POST", { as: ADMIN, body: { action: "preview" } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "ยังไม่ได้เชื่อมต่อปฏิทินใหม่");
    assert.equal(h.google.made.length, 0);
  }
});

test("preview/switch/clearLock: 401/403 for non-admins with zero settings reads and zero Google clients", async () => {
  const h = harness({ settings: { ...SETTINGS(), candidate: CAND(), lock: { since: 1_000_000 - 1000, by: ADMIN } } });
  for (const action of ["preview", "switch", "clearLock"]) {
    for (const as of [undefined, "stranger@gmail.com"]) assert.equal((await call(h, "POST", { as, body: { action } })).status, 401);
    for (const as of ["hnbcmu@gmail.com", "view@cmu.ac.th"]) assert.equal((await call(h, "POST", { as, body: { action } })).status, 403);
    assert.equal((await call(h, "POST", { as: ADMIN, body: { action }, contentType: "text/plain" })).status, 415);
  }
  assert.equal(h.state.reads, 0);
  assert.equal(h.state.writes, 0);
  assert.equal(h.google.made.length, 0);
  assert.ok(h.state.data.lock);
});

test("preview returns counts, skipped, byMonth and target info only (no event content, no token)", async () => {
  const h = harness({
    settings: { ...SETTINGS(), candidate: CAND() },
    calendars: { "hnbcmu@gmail.com": SRC(), "cal-new@group.calendar.google.com": [EV.personal] },
  });
  const out = await spyConsole(async () => {
    const r = await call(h, "POST", { as: ADMIN, body: { action: "preview" } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      tokenOnly: false,
      counts: { booking: 1, extra_day: 1, schedule_closure: 0, staff_unavailable: 0, legacy: 0 },
      skipped: 1,
      byMonth: { "2026-12": 1, "2027-01": 1 },
      targetEventCount: 1,
      targetHasEvents: true,
      targetConflicts: 0,
      invalidIds: 0,
      recurring: 0,
      diagnostics: {
        invalidIds: {
          reasons: { uppercase: 0, hyphen: 0, underscore: 0, tooShort: 0, tooLong: 0, otherChars: 0 },
          shapes: [],
          byKind: { app: 0, legacy: 0, recurringMasters: 0 },
        },
        recurring: {
          masters: 0,
          exceptionInstances: 0,
          mastersPlanned: 0,
          infiniteMasters: 0,
          byFreq: { DAILY: 0, WEEKLY: 0, MONTHLY: 0, YEARLY: 0, other: 0 },
          exceptionsCancelled: 0,
        },
        skippedReasons: { cancelled: 0, recurringException: 0, notReadable: 1 },
      },
    });
    for (const leak of ["SYNTH-SUMMARY", "SYNTH-HN-9", "Lunch", NEW_TOKEN, MASTER_TOKEN, "v1."]) assert.ok(!r.text.includes(leak), leak);
  });
  assert.ok(!out.includes(NEW_TOKEN) && !out.includes(MASTER_TOKEN));
  // the master client got the master's token, the candidate client the candidate's
  assert.deepEqual(h.google.made, [
    { calendarId: "hnbcmu@gmail.com", refreshToken: MASTER_TOKEN },
    { calendarId: "cal-new@group.calendar.google.com", refreshToken: NEW_TOKEN },
  ]);
  assert.equal(h.state.writes, 0);
});

test("preview in env mode uses GOOGLE_REFRESH_TOKEN for the source; without it preview and switch are refused", async () => {
  const h = harness({ settings: { candidate: CAND() }, env: { GOOGLE_REFRESH_TOKEN: MASTER_TOKEN, GOOGLE_CALENDAR_ID: "env-cal" }, calendars: { "env-cal": SRC() } });
  const r = await call(h, "POST", { as: ADMIN, body: { action: "preview" } });
  assert.equal(r.status, 200);
  assert.deepEqual(h.google.made[0], { calendarId: "env-cal", refreshToken: MASTER_TOKEN });
  assert.equal(r.json.targetHasEvents, false);

  const h2 = harness({ settings: { candidate: CAND() } });
  for (const action of ["preview", "switch"]) {
    const r2 = await call(h2, "POST", { as: ADMIN, body: { action } });
    assert.equal(r2.status, 409);
    assert.equal(r2.json.error, api.NO_SOURCE_TOKEN_MESSAGE);
  }
  assert.equal(h2.google.made.length, 0);
  assert.equal(h2.state.writes, 0);
});

test("switch copies, flips the master, keeps previousMaster, and returns the new status (no token)", async () => {
  const h = harness({ settings: { ...SETTINGS(), candidate: CAND() }, calendars: { "hnbcmu@gmail.com": SRC() } });
  const out = await spyConsole(async () => {
    const r = await call(h, "POST", { as: ADMIN, body: { action: "switch" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.mode, "copy");
    assert.equal(r.json.copied, 2);
    assert.equal(r.json.skipped, 1);
    assert.equal(r.json.lockCleared, true);
    assert.deepEqual(r.json.status.master, { email: "new@gmail.com", calendarId: "cal-new@group.calendar.google.com", source: "settings" });
    assert.equal(r.json.status.locked, false);
    for (const leak of [NEW_TOKEN, MASTER_TOKEN, "v1.", "SYNTH-HN-9"]) assert.ok(!r.text.includes(leak), leak);
  });
  assert.ok(!out.includes(NEW_TOKEN) && !out.includes(MASTER_TOKEN));
  assert.deepEqual([...h.google.cals.get("cal-new@group.calendar.google.com").keys()].sort(), ["bk0001aa", "ea0001aa"]);
  assert.equal(openToken(h.state.data.master.sealedRefreshToken, KEY), NEW_TOKEN);
  assert.equal(openToken(h.state.data.previousMaster.sealedRefreshToken, KEY), MASTER_TOKEN);
  assert.equal(h.state.data.lock, undefined);
  assert.equal(h.state.data.candidate, undefined);
  assert.ok(h.sleeps.some((ms) => ms >= 35_000));
});

test("switch in env mode seeds previousMaster with the sealed env master", async () => {
  const h = harness({ settings: { candidate: CAND() }, env: { GOOGLE_REFRESH_TOKEN: MASTER_TOKEN, GOOGLE_CALENDAR_ID: "env-cal" }, calendars: { "env-cal": SRC() } });
  const r = await call(h, "POST", { as: ADMIN, body: { action: "switch" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(h.state.data.previousMaster.email, "hnbcmu@gmail.com");
  assert.equal(h.state.data.previousMaster.calendarId, "env-cal");
  assert.equal(openToken(h.state.data.previousMaster.sealedRefreshToken, KEY), MASTER_TOKEN);
  assert.equal(h.state.data.master.calendarId, "cal-new@group.calendar.google.com");
});

test("switch to the same email + calendar is a token-only refresh: no Google client, no copy, previousMaster kept", async () => {
  const older = target("old@gmail.com", "old-id", "SYNTH-OLD-TOKEN-cccc");
  const renewed = target("HNBCMU@gmail.com", "hnbcmu@gmail.com", NEW_TOKEN);
  const h = harness({ settings: { ...SETTINGS(), previousMaster: older, candidate: { ...renewed, email: "hnbcmu@gmail.com" } } });
  const r = await call(h, "POST", { as: ADMIN, body: { action: "switch" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.mode, "token");
  assert.equal(h.google.made.length, 0);
  assert.equal(openToken(h.state.data.master.sealedRefreshToken, KEY), NEW_TOKEN);
  assert.equal(h.state.data.master.calendarId, "hnbcmu@gmail.com");
  assert.deepEqual(h.state.data.previousMaster, older);
  assert.equal(h.state.data.candidate, undefined);
  assert.equal(h.state.data.lock, undefined);
  assert.ok(!r.text.includes(NEW_TOKEN));

  // env mode (no GOOGLE_REFRESH_TOKEN needed): same account as the env master
  const h2 = harness({ settings: { candidate: target("hnbcmu@gmail.com", "env-cal", NEW_TOKEN) }, env: { GOOGLE_CALENDAR_ID: "env-cal" } });
  const r2 = await call(h2, "POST", { as: ADMIN, body: { action: "switch" } });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(r2.json.mode, "token");
  assert.equal(h2.google.made.length, 0);
  assert.equal(openToken(h2.state.data.master.sealedRefreshToken, KEY), NEW_TOKEN);
  assert.equal(h2.state.data.previousMaster, undefined);

  // preview says token-only without touching Google
  const h3 = harness({ settings: { ...SETTINGS(), candidate: { ...renewed, email: "hnbcmu@gmail.com" } } });
  const r3 = await call(h3, "POST", { as: ADMIN, body: { action: "preview" } });
  assert.deepEqual(r3.json, { tokenOnly: true });
  assert.equal(h3.google.made.length, 0);
});

test("switch is refused while a lock is active, without a key, or without a candidate", async () => {
  const locked = harness({ settings: { ...SETTINGS(), candidate: CAND(), lock: { since: 1_000_000 - 1000, by: ADMIN } } });
  const r = await call(locked, "POST", { as: ADMIN, body: { action: "switch" } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "ระบบกำลังเปลี่ยนปฏิทิน กรุณาลองใหม่ในอีกสักครู่");
  assert.equal(locked.google.made.length, 0);

  for (const key of [null, "bad-key"]) {
    const h = harness({ settings: { ...SETTINGS(), candidate: CAND() }, key });
    for (const action of ["switch", "preview"]) {
      const r2 = await call(h, "POST", { as: ADMIN, body: { action } });
      assert.equal(r2.status, 503);
      assert.equal(r2.json.error, "ยังไม่ได้ตั้งค่า CALENDAR_SETTINGS_KEY");
    }
    assert.equal(h.google.made.length, 0);
  }

  const none = harness({ settings: SETTINGS() });
  const r3 = await call(none, "POST", { as: ADMIN, body: { action: "switch" } });
  assert.equal(r3.status, 409);
  assert.equal(r3.json.error, "ยังไม่ได้เชื่อมต่อปฏิทินใหม่");
});

test("switch failure returns the step and its fixed Thai message; master unchanged and lock cleared", async () => {
  const h = harness({ settings: { ...SETTINGS(), candidate: CAND() }, calendars: { "hnbcmu@gmail.com": SRC() } });
  const real = h.deps.makeClient;
  h.deps.makeClient = (t) => {
    const c = real(t);
    if (t.calendarId === "hnbcmu@gmail.com") c.listEvents = async () => { throw new Error(`SYNTH google ${MASTER_TOKEN}`); };
    return c;
  };
  const out = await spyConsole(async () => {
    const r = await call(h, "POST", { as: ADMIN, body: { action: "switch" } });
    assert.equal(r.status, 502);
    assert.equal(r.json.step, "read");
    assert.equal(typeof r.json.error, "string");
    assert.ok(!r.text.includes(MASTER_TOKEN));
  });
  assert.ok(!out.includes(MASTER_TOKEN));
  assert.equal(h.state.data.master.calendarId, "hnbcmu@gmail.com");
  assert.equal(h.state.data.lock, undefined);
  assert.ok(h.state.data.candidate);
});

test("clearLock clears an active lock; on a lock-only file it deletes the file instead of writing {}", async () => {
  const h = harness({ settings: { ...SETTINGS(), candidate: CAND(), lock: { since: 1_000_000 - 1000, by: ADMIN } } });
  const r = await call(h, "POST", { as: ADMIN, body: { action: "clearLock" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.locked, false);
  assert.equal(h.state.data.lock, undefined);
  assert.ok(h.state.data.master && h.state.data.candidate);
  assert.equal(h.google.made.length, 0);

  const h2 = harness({ settings: { lock: { since: 1_000_000 - 1000, by: ADMIN } } });
  const r2 = await call(h2, "POST", { as: ADMIN, body: { action: "clearLock" } });
  assert.equal(r2.status, 200);
  assert.equal(h2.state.data, "missing");
  assert.equal(h2.state.removes, 1);
  assert.equal(r2.json.master.source, "env");

  // no lock: nothing is written
  const h3 = harness({ settings: SETTINGS() });
  const r3 = await call(h3, "POST", { as: ADMIN, body: { action: "clearLock" } });
  assert.equal(r3.status, 200);
  assert.equal(h3.state.writes, 0);
});

test("candidate = the master's own calendar: \"primary\" alias is token-only; same id via another account is refused", async () => {
  // settings master hnbcmu@gmail.com reached as "primary" by the same account => token-only, no copy
  const h = harness({ settings: { ...SETTINGS(), candidate: target("hnbcmu@gmail.com", "primary", NEW_TOKEN) } });
  const r = await call(h, "POST", { as: ADMIN, body: { action: "switch" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.mode, "token");
  assert.equal(h.state.data.master.calendarId, "hnbcmu@gmail.com");
  assert.equal(openToken(h.state.data.master.sealedRefreshToken, KEY), NEW_TOKEN);
  assert.equal(h.google.made.length, 0);

  // env master (calendar id = AUTHORIZED_EMAIL) renewed via "primary" => token-only
  const h2 = harness({ settings: { candidate: target("hnbcmu@gmail.com", "PRIMARY", NEW_TOKEN) }, env: { GOOGLE_REFRESH_TOKEN: MASTER_TOKEN } });
  assert.deepEqual((await call(h2, "POST", { as: ADMIN, body: { action: "preview" } })).json, { tokenOnly: true });
  const r2 = await call(h2, "POST", { as: ADMIN, body: { action: "switch" } });
  assert.equal(r2.json.mode, "token");
  assert.equal(h2.google.made.length, 0);

  // same calendar id (any case) through a different account => 409, no Google client, nothing written
  const h3 = harness({ settings: { ...SETTINGS(), candidate: target("new@gmail.com", "HNBCMU@gmail.com", NEW_TOKEN) }, calendars: { "hnbcmu@gmail.com": SRC() } });
  for (const action of ["preview", "switch"]) {
    const r3 = await call(h3, "POST", { as: ADMIN, body: { action } });
    assert.equal(r3.status, 409);
    assert.equal(r3.json.error, api.SAME_CALENDAR_OTHER_ACCOUNT_MESSAGE);
  }
  assert.equal(h3.google.made.length, 0);
  assert.equal(h3.state.writes, 0);
});

test("preview reports how many source events are recurring (masters or exception instances)", async () => {
  const recurringMaster = { ...EV.extra, id: "rm0001aa", recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"] };
  const exception = { id: "rm0001aa_20270111", status: "cancelled", recurringEventId: "rm0001aa" };
  const h = harness({ settings: { ...SETTINGS(), candidate: CAND() }, calendars: { "hnbcmu@gmail.com": [...SRC(), recurringMaster, exception] } });
  const r = await call(h, "POST", { as: ADMIN, body: { action: "preview" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.recurring, 2);
});

test("switch whose flip landed but was reported as failed never says 'not switched'", async () => {
  const h = harness({ settings: { ...SETTINGS(), candidate: CAND() }, calendars: { "hnbcmu@gmail.com": SRC() } });
  const inner = h.deps.settings;
  let failNextRead = false;
  h.deps.settings = {
    async read(opts) {
      if (failNextRead) { failNextRead = false; throw new Error("SYNTH read failed"); }
      return inner.read(opts);
    },
    async mutate(fn) {
      const next = await inner.mutate(fn);
      if (next !== "missing" && next.master?.calendarId === "cal-new@group.calendar.google.com" && next.lock) {
        failNextRead = true; // the runSwitch read-back fails too: outcome unknown inside runSwitch
        throw new Error("SYNTH ambiguous timeout after landing");
      }
      return next;
    },
  };
  const r = await call(h, "POST", { as: ADMIN, body: { action: "switch" } });
  assert.notEqual(r.status, 200);
  assert.equal(r.json.switched, true);
  assert.equal(r.json.error, api.SWITCHED_WITH_ERROR_MESSAGE);
  assert.ok(!r.text.includes("ยังไม่ได้เปลี่ยนปฏิทิน"));
  assert.equal(h.state.data.master.calendarId, "cal-new@group.calendar.google.com");
  assert.equal(h.state.data.lock, undefined);
  assert.ok(!r.text.includes(NEW_TOKEN) && !r.text.includes(MASTER_TOKEN));
});

test("admin calendar route sets maxDuration = 300", async () => {
  const src = await readFile(new URL("../app/api/admin/calendar/route.ts", import.meta.url), "utf8");
  assert.match(src, /export const maxDuration = 300;/);
});

test("GET exposes lockedSince (a number) only while the lock is active, never for an expired lock", async () => {
  const active = await call(harness({ settings: { ...SETTINGS(), lock: { since: 1_000_000 - 5000, by: ADMIN } } }), "GET", { as: ADMIN });
  assert.equal(active.json.locked, true);
  assert.equal(active.json.lockedSince, 1_000_000 - 5000);
  const expired = await call(harness({ settings: { ...SETTINGS(), lock: { since: 1_000_000 - 21 * 60_000, by: ADMIN } } }), "GET", { as: ADMIN });
  assert.equal(expired.json.locked, false);
  assert.ok(!("lockedSince" in expired.json));
});

// ---- final fix wave: preflight before the lock (rollback rule), event ids, email_verified -------------
const sw = await import("../app/lib/calendar-switch.ts");
const { resolveCalendarTarget } = await import("../app/lib/calendar-target.ts");
const evX = (id) => ({ id, summary: "x", start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day", note: "" } } });
// counts upserts per calendar id on top of the in-memory calendars
function countUpserts(h) {
  const upserts = {};
  const lists = [];
  const real = h.deps.makeClient;
  h.deps.makeClient = (t) => {
    const c = real(t);
    const up = c.upsertEvent;
    const list = c.listEvents;
    c.upsertEvent = async (e) => { upserts[t.calendarId] = (upserts[t.calendarId] ?? 0) + 1; return up(e); };
    c.listEvents = async (opts) => { lists.push({ calendarId: t.calendarId, deadline: opts?.deadline }); return list(opts); };
    return c;
  };
  return { upserts, lists };
}

test("switch back into the OLD populated calendar after a delete on the new master is refused BEFORE the lock; a NEW EMPTY calendar works", async () => {
  // After the first switch: B is the master, A the previous master. ev2 was cancelled (hard-deleted) on B,
  // ev3 created on B. The owner reconnects A (fresh token) and tries to switch back.
  const B = target("b@gmail.com", "cal-b", "SYNTH-B-REFRESH-TOKEN-dddd");
  const A = target("hnbcmu@gmail.com", "cal-a", MASTER_TOKEN);
  const A2 = target("hnbcmu@gmail.com", "cal-a", "SYNTH-A-FRESH-TOKEN-eeee");
  const h = harness({
    settings: { master: B, previousMaster: A, candidate: A2 },
    calendars: { "cal-b": [evX("ev1aaaaa"), evX("ev3aaaaa")], "cal-a": [evX("ev1aaaaa"), evX("ev2aaaaa")] },
    verify: () => ({ email: "c@gmail.com" }),
  });
  const seen = countUpserts(h);
  const before = structuredClone(h.state.data);

  const preview = await call(h, "POST", { as: ADMIN, body: { action: "preview" } });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.targetConflicts, 1);
  assert.equal(preview.json.invalidIds, 0);

  const r = await call(h, "POST", { as: ADMIN, body: { action: "switch" } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.step, "preflight");
  assert.equal(r.json.switched, false);
  assert.equal(r.json.error, sw.TARGET_CONFLICTS_MESSAGE);
  // no lock was ever taken, nothing written, the old calendar untouched
  assert.equal(h.state.writes, 0);
  assert.deepEqual(h.state.data, before);
  assert.equal(seen.upserts["cal-a"] ?? 0, 0);
  assert.deepEqual([...h.google.cals.get("cal-a").keys()].sort(), ["ev1aaaaa", "ev2aaaaa"]);
  // writes stay unfrozen: the app's resolver sees no lock and the current master
  const resolved = await resolveCalendarTarget({ store: h.store, env: { AUTHORIZED_EMAIL: "hnbcmu@gmail.com", CALENDAR_SETTINGS_KEY: KEY }, now: 1_000_000 });
  assert.equal(resolved.locked, false);
  assert.equal(resolved.calendarId, "cal-b");

  // The safe rollback: connect a NEW, EMPTY calendar and switch into it.
  const c = await call(h, "POST", { as: ADMIN, body: { action: "connect", email: "c@gmail.com", calendarId: "cal-c", refreshToken: "SYNTH-C-REFRESH-TOKEN-ffff" } });
  assert.equal(c.status, 200, c.text);
  const ok = await call(h, "POST", { as: ADMIN, body: { action: "switch" } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(h.state.data.master.calendarId, "cal-c");
  assert.equal(h.state.data.previousMaster.calendarId, "cal-b");
  assert.equal(h.state.data.lock, undefined);
  assert.deepEqual([...h.google.cals.get("cal-c").keys()].sort(), ["ev1aaaaa", "ev3aaaaa"]);
});

test("source events whose ids Google's insert-with-id rejects: preview counts them, switch refuses BEFORE the lock", async () => {
  const h = harness({ settings: { ...SETTINGS(), candidate: CAND() }, calendars: { "hnbcmu@gmail.com": [...SRC(), evX("Outlook-Imported-1"), evX("ab-cd-ef")] } });
  const seen = countUpserts(h);
  const p = await call(h, "POST", { as: ADMIN, body: { action: "preview" } });
  assert.equal(p.status, 200);
  assert.equal(p.json.invalidIds, 2);
  const r = await call(h, "POST", { as: ADMIN, body: { action: "switch" } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.step, "preflight");
  assert.equal(r.json.error, sw.INVALID_EVENT_IDS_MESSAGE);
  assert.match(sw.INVALID_EVENT_IDS_MESSAGE, /หยุด/);
  assert.match(sw.INVALID_EVENT_IDS_MESSAGE, /ติดต่อผู้พัฒนา/);
  assert.match(sw.INVALID_EVENT_IDS_MESSAGE, /ห้ามแก้ไขหรือลบ/);
  assert.equal(h.state.writes, 0);
  assert.equal(h.state.data.lock, undefined);
  assert.equal(Object.keys(seen.upserts).length, 0);
});

test("preflight: a failed target read is a fixed 502 (step preflight) with no lock and no write; source read failure keeps step read", async () => {
  const h = harness({ settings: { ...SETTINGS(), candidate: CAND() }, calendars: { "hnbcmu@gmail.com": SRC() } });
  const real = h.deps.makeClient;
  h.deps.makeClient = (t) => {
    const c = real(t);
    if (t.calendarId !== "hnbcmu@gmail.com") c.listEvents = async () => { throw new Error(`SYNTH google ${NEW_TOKEN}`); };
    return c;
  };
  const out = await spyConsole(async () => {
    const r = await call(h, "POST", { as: ADMIN, body: { action: "switch" } });
    assert.equal(r.status, 502);
    assert.equal(r.json.step, "preflight");
    assert.equal(r.json.error, sw.PREFLIGHT_TARGET_FAILED_MESSAGE);
    assert.ok(!r.text.includes(NEW_TOKEN));
  });
  assert.ok(!out.includes(NEW_TOKEN));
  assert.equal(h.state.writes, 0);
  assert.equal(h.state.data.lock, undefined);
});

test("preflight lists are bounded (copy budget) and reuse the run's two clients; the run's budget counts from the request start", async () => {
  const h = harness({ settings: { ...SETTINGS(), candidate: CAND() }, calendars: { "hnbcmu@gmail.com": SRC() } });
  const seen = countUpserts(h);
  const r = await call(h, "POST", { as: ADMIN, body: { action: "switch" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(h.google.made.length, 2, "one source and one target client for preflight + run");
  // first two lists = preflight (source, target) with the copy-budget deadline; then the run's hard deadline
  assert.deepEqual(seen.lists.slice(0, 2).map((l) => l.calendarId), ["hnbcmu@gmail.com", "cal-new@group.calendar.google.com"]);
  for (const l of seen.lists.slice(0, 2)) assert.equal(l.deadline, 1_000_000 + sw.COPY_PHASE_BUDGET_MS);
  for (const l of seen.lists.slice(2)) assert.equal(l.deadline, 1_000_000 + sw.RUN_HARD_DEADLINE_MS);
});

test("production verifyGoogleAccount fails closed unless the ID token says email_verified === true", async () => {
  const idToken = (claims) => `h.${Buffer.from(JSON.stringify({ email: "New@Gmail.com", ...claims })).toString("base64url")}.s`;
  const fetchWith = (token) => async (url) =>
    String(url).includes("oauth2") ? Response.json({ access_token: "SYNTH-ACCESS", id_token: token }) : Response.json({ items: [] });
  const io = (token) => ({ fetch: fetchWith(token), clientId: "cid", clientSecret: "s" });
  assert.deepEqual(await api.verifyGoogleAccount({ refreshToken: NEW_TOKEN, calendarId: "c" }, io(idToken({ email_verified: true }))), { email: "new@gmail.com" });
  for (const claims of [{}, { email_verified: false }, { email_verified: "true" }, { email_verified: 1 }]) {
    await assert.rejects(api.verifyGoogleAccount({ refreshToken: NEW_TOKEN, calendarId: "c" }, io(idToken(claims))), JSON.stringify(claims));
  }
});

test("preview diagnostics describe invalid ids and recurring events without leaking ids or text", async () => {
  const bad = { ...EV.extra, id: "Bad-Id_ZZ9", summary: "SYNTH-LEAK-SUMMARY", recurrence: ["RRULE:FREQ=WEEKLY"] };
  const h = harness({ settings: { ...SETTINGS(), candidate: CAND() }, calendars: { "hnbcmu@gmail.com": [...SRC(), bad] } });
  const r = await call(h, "POST", { as: ADMIN, body: { action: "preview" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.invalidIds, 1);
  assert.equal(r.json.recurring, 1);
  assert.deepEqual(r.json.diagnostics.invalidIds.shapes, [{ shape: "Aaa-Aa_AA9", count: 1 }]);
  assert.equal(r.json.diagnostics.invalidIds.reasons.uppercase, 1);
  assert.equal(r.json.diagnostics.recurring.infiniteMasters, 1);
  for (const leak of ["Bad-Id_ZZ9", "SYNTH-LEAK-SUMMARY"]) assert.ok(!r.text.includes(leak), leak);
});
