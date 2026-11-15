import assert from "node:assert/strict";
import test from "node:test";
import "./ts-resolve.mjs";

const {
  isLockActive,
  withLock,
  withoutLock,
  promoteCandidate,
  setCandidate,
  validateConnectInput,
} = await import("../app/lib/calendar-settings.ts");

const t = (n) => ({ email: `${n}@example.com`, calendarId: `cal-${n}`, sealedRefreshToken: `v1.${n}.x.y` });
const MIN = 60_000;

test("lock expires after 20 minutes", () => {
  const s = withLock({ master: t("a") }, "admin@example.com", 1_000_000);
  assert.deepEqual(s.lock, { since: 1_000_000, by: "admin@example.com" });
  assert.equal(isLockActive(s, 1_000_000 + 19 * MIN), true);
  assert.equal(isLockActive(s, 1_000_000 + 20 * MIN), false);
  assert.equal(isLockActive({ master: t("a") }, 5), false);
});

test("withoutLock removes lock without mutating input", () => {
  const s = withLock({ master: t("a") }, "x", 1);
  const r = withoutLock(s);
  assert.equal(r.lock, undefined);
  assert.ok(s.lock);
});

test("setCandidate sets candidate", () => {
  const s = setCandidate({ master: t("a") }, t("b"));
  assert.deepEqual(s.candidate, t("b"));
  assert.deepEqual(s.master, t("a"));
});

test("promoteCandidate moves master to previousMaster, clears candidate and lock", () => {
  const s = withLock(setCandidate({ master: t("a"), previousMaster: t("z") }, t("b")), "x", 1);
  const r = promoteCandidate(s);
  assert.deepEqual(r.master, t("b"));
  assert.deepEqual(r.previousMaster, t("a"));
  assert.equal(r.candidate, undefined);
  assert.equal(r.lock, undefined);
});

test("promoteCandidate without candidate throws", () => {
  assert.throws(() => promoteCandidate({ master: t("a") }));
});

test("validateConnectInput", () => {
  const ok = validateConnectInput({ email: " A@Example.com ", calendarId: "abc@group.calendar.google.com", refreshToken: "tok" });
  assert.deepEqual(ok, { ok: true, value: { email: "a@example.com", calendarId: "abc@group.calendar.google.com", refreshToken: "tok" } });
  const bad = (o) => assert.equal(validateConnectInput(o).ok, false);
  bad(null);
  bad("x");
  bad({ email: "nope", calendarId: "c", refreshToken: "t" });
  bad({ email: "a@example.com", calendarId: "", refreshToken: "t" });
  bad({ email: "a@example.com", calendarId: "has space", refreshToken: "t" });
  bad({ email: "a@example.com", calendarId: "c".repeat(257), refreshToken: "t" });
  bad({ email: "a@example.com", calendarId: "c", refreshToken: "" });
  bad({ email: "a@example.com", calendarId: "c", refreshToken: "t".repeat(2049) });
  bad({ email: 5, calendarId: "c", refreshToken: "t" });
});
