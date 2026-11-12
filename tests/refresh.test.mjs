import assert from "node:assert/strict";
import test from "node:test";
import "./ts-resolve.mjs";

const { REFRESH_THROTTLE_MS, REFRESH_INTERVAL_MS, FORM_IDLE_MS, STALE_AFTER_MS, shouldRefreshQuietly, freshnessLabel } =
  await import("../app/lib/refresh.ts");

const NOW = 1e9;
const base = { now: NOW, lastLoadedAt: NOW - 61_000, inFlight: false, busy: false, dialogOpen: false, lastFormEditAt: null };

test("constants", () => {
  assert.equal(REFRESH_THROTTLE_MS, 60_000);
  assert.equal(REFRESH_INTERVAL_MS, 300_000);
  assert.equal(FORM_IDLE_MS, 180_000);
  assert.equal(STALE_AFTER_MS, 600_000);
});

test("shouldRefreshQuietly allows an idle, old-enough state", () => {
  assert.equal(shouldRefreshQuietly(base), true);
  assert.equal(shouldRefreshQuietly({ ...base, lastLoadedAt: null }), true);
});

test("shouldRefreshQuietly throttles recent loads", () => {
  assert.equal(shouldRefreshQuietly({ ...base, lastLoadedAt: NOW - 59_000 }), false);
});

test("shouldRefreshQuietly blocks while in flight, busy or dialog open", () => {
  assert.equal(shouldRefreshQuietly({ ...base, inFlight: true }), false);
  assert.equal(shouldRefreshQuietly({ ...base, busy: true }), false);
  assert.equal(shouldRefreshQuietly({ ...base, dialogOpen: true }), false);
});

test("shouldRefreshQuietly waits for form idle", () => {
  assert.equal(shouldRefreshQuietly({ ...base, lastFormEditAt: NOW - 179_000 }), false);
  assert.equal(shouldRefreshQuietly({ ...base, lastFormEditAt: NOW - 181_000 }), true);
});

test("freshnessLabel ok", () => {
  const f = freshnessLabel(NOW, NOW - 5 * 60_000, 12, false);
  assert.equal(f.tone, "ok");
  assert.match(f.text, /^อัปเดตล่าสุด \d{2}:\d{2} น\. · ข้อมูลเดิม 12 เคส$/);
});

test("freshnessLabel stale", () => {
  assert.deepEqual(freshnessLabel(NOW, NOW - 12 * 60_000, 12, false), {
    tone: "stale",
    text: "อัปเดตเมื่อ 12 นาทีที่แล้ว · ข้อมูลเดิม 12 เคส",
  });
});

test("freshnessLabel failed", () => {
  const f = freshnessLabel(NOW, NOW - 60_000, 12, true);
  assert.equal(f.tone, "failed");
  assert.match(f.text, /^เชื่อมต่อไม่ได้ · ข้อมูลล่าสุดเมื่อ \d{2}:\d{2} น\.$/);
});
