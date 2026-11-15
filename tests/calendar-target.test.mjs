import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import "./ts-resolve.mjs";

const { resolveCalendarTarget, MASTER_PLACEHOLDER } = await import("../app/lib/calendar-target.ts");
const { sealToken } = await import("../app/lib/token-seal.ts");
const { LOCK_TTL_MS } = await import("../app/lib/calendar-settings.ts");

const KEY = randomBytes(32).toString("base64");
const NOW = 1_800_000_000_000;
const env = (extra = {}) => ({ AUTHORIZED_EMAIL: "owner@example.com", ...extra });
const settings = (extra = {}) => ({
  master: { email: "m@example.com", calendarId: "cal-m@example.com", sealedRefreshToken: sealToken("tok-master", KEY) },
  ...extra,
});
const store = (value) => ({ read: async () => value });

test("placeholder constant", () => assert.equal(MASTER_PLACEHOLDER, "@master"));

test("no settings file: env id (GOOGLE_CALENDAR_ID wins) and env token", async () => {
  const a = await resolveCalendarTarget({ store: store("missing"), env: env({ GOOGLE_CALENDAR_ID: "cal-env", GOOGLE_REFRESH_TOKEN: "rt-env" }), now: NOW });
  assert.deepEqual(a, { source: "env", calendarId: "cal-env", refreshToken: "rt-env", locked: false });
  const b = await resolveCalendarTarget({ store: store("missing"), env: env(), now: NOW });
  assert.deepEqual(b, { source: "env", calendarId: "owner@example.com", refreshToken: null, locked: false });
});

test("settings present: settings id and unsealed token; env ignored", async () => {
  const r = await resolveCalendarTarget({ store: store(settings()), env: env({ GOOGLE_CALENDAR_ID: "cal-env", GOOGLE_REFRESH_TOKEN: "rt-env", CALENDAR_SETTINGS_KEY: KEY }), now: NOW });
  assert.deepEqual(r, { source: "settings", calendarId: "cal-m@example.com", refreshToken: "tok-master", locked: false });
});

test("store read failure rejects 503 with the Thai message and never falls back to env", async () => {
  const bad = { read: async () => { throw new Error("blob down secret-detail"); } };
  await assert.rejects(
    resolveCalendarTarget({ store: bad, env: env({ GOOGLE_REFRESH_TOKEN: "rt-env", CALENDAR_SETTINGS_KEY: KEY }), now: NOW }),
    (e) => e.status === 503 && e.message === "อ่านการตั้งค่าปฏิทินไม่สำเร็จ กรุณาลองใหม่",
  );
});

test("sealed token with wrong or missing key rejects 503 without leaking anything", async () => {
  for (const key of [randomBytes(32).toString("base64"), undefined, "short"]) {
    await assert.rejects(
      resolveCalendarTarget({ store: store(settings()), env: env({ CALENDAR_SETTINGS_KEY: key }), now: NOW }),
      (e) => e.status === 503 && e.message === "อ่านการตั้งค่าปฏิทินไม่สำเร็จ กรุณาลองใหม่" && !e.message.includes("tok-master"),
    );
  }
});

test("lock: active => locked true, expired => false", async () => {
  const e = env({ CALENDAR_SETTINGS_KEY: KEY });
  const active = await resolveCalendarTarget({ store: store(settings({ lock: { since: NOW - 1000, by: "a@example.com" } })), env: e, now: NOW });
  assert.equal(active.locked, true);
  const expired = await resolveCalendarTarget({ store: store(settings({ lock: { since: NOW - LOCK_TTL_MS - 1, by: "a@example.com" } })), env: e, now: NOW });
  assert.equal(expired.locked, false);
});

test("allowCached is forwarded to the store only when the caller asks (GET)", async () => {
  const seen = [];
  const s = { read: async (o) => { seen.push(o?.allowCached); return "missing"; } };
  await resolveCalendarTarget({ store: s, env: env(), now: NOW, allowCached: true });
  await resolveCalendarTarget({ store: s, env: env(), now: NOW });
  assert.deepEqual(seen, [true, false]);
});

test("settings without master behave as env (source env, env token) and still honor an active lock", async () => {
  const e = env({ GOOGLE_CALENDAR_ID: "cal-env", GOOGLE_REFRESH_TOKEN: "rt-env" });
  const cand = { email: "c@example.com", calendarId: "cal-c", sealedRefreshToken: sealToken("tok-c", KEY) };
  const a = await resolveCalendarTarget({ store: store({ candidate: cand }), env: e, now: NOW });
  assert.deepEqual(a, { source: "env", calendarId: "cal-env", refreshToken: "rt-env", locked: false });
  const b = await resolveCalendarTarget({ store: store({ candidate: cand, lock: { since: NOW - 1000, by: "a@example.com" } }), env: e, now: NOW });
  assert.deepEqual(b, { source: "env", calendarId: "cal-env", refreshToken: "rt-env", locked: true });
  const c = await resolveCalendarTarget({ store: store({ lock: { since: NOW - LOCK_TTL_MS - 1, by: "a@example.com" } }), env: e, now: NOW });
  assert.equal(c.locked, false);
});

test("a settings master whose token unseals to an empty string is unreadable (503), never the per-device path", async () => {
  const empty = { master: { email: "m@example.com", calendarId: "cal-m@example.com", sealedRefreshToken: sealToken("", KEY) } };
  await assert.rejects(
    resolveCalendarTarget({ store: store(empty), env: env({ GOOGLE_REFRESH_TOKEN: "rt-env", CALENDAR_SETTINGS_KEY: KEY }), now: NOW }),
    (e) => e.status === 503 && e.message === "อ่านการตั้งค่าปฏิทินไม่สำเร็จ กรุณาลองใหม่",
  );
});

test("resolveCalendarPath substitutes @master with the encoded id; queries and placeholder-free paths untouched", async () => {
  const { resolveCalendarPath } = await import("../app/lib/calendar-target.ts");
  assert.equal(resolveCalendarPath("/calendars/@master/events?q=a%40b&pageToken=x", "cal-m@example.com"), "/calendars/cal-m%40example.com/events?q=a%40b&pageToken=x");
  assert.equal(resolveCalendarPath("/calendars/@master/events/ab01cd23", "a#b$c@group.calendar.google.com"), "/calendars/a%23b%24c%40group.calendar.google.com/events/ab01cd23");
  // `$&`-style patterns in the id can never be interpreted as replacement patterns
  assert.equal(resolveCalendarPath("/calendars/@master/events", "$&$1"), "/calendars/%24%26%241/events");
  assert.equal(resolveCalendarPath("/users/me/calendarList", "cal-m@example.com"), "/users/me/calendarList");
  // only the path segment is replaced (first occurrence), a literal "@master" in a query stays
  assert.equal(resolveCalendarPath("/calendars/@master/events?q=@master", "c"), "/calendars/c/events?q=@master");
});

test("no settings file: the resolved Calendar URL is exactly the pre-phase-B form", async () => {
  const { resolveCalendarPath } = await import("../app/lib/calendar-target.ts");
  for (const e of [env({ GOOGLE_CALENDAR_ID: "cal-env@group.calendar.google.com", GOOGLE_REFRESH_TOKEN: "rt-env" }), env()]) {
    const target = await resolveCalendarTarget({ store: store("missing"), env: e, now: NOW });
    const oldId = e.GOOGLE_CALENDAR_ID || e.AUTHORIZED_EMAIL; // the old CALENDAR_ID constant
    const path = `/calendars/@master/events?singleEvents=true&maxResults=2500`;
    assert.equal(resolveCalendarPath(path, target.calendarId), `/calendars/${encodeURIComponent(oldId)}/events?singleEvents=true&maxResults=2500`);
  }
});
