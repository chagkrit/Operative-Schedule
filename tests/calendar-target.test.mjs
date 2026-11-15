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
