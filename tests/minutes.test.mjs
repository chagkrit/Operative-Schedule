import assert from "node:assert/strict";
import test from "node:test";
import "./ts-resolve.mjs";

const { DAILY_MINUTES_LIMIT, durationInputError, parseDurationMinutes, roomDayMinutes, minutesRefusal, minutesRefusalMessage } =
  await import("../app/lib/minutes.ts");

const REQUIRED = "กรุณากรอกระยะเวลาผ่าตัดเป็นนาที";
const RANGE = "ระยะเวลาผ่าตัดต้องเป็นจำนวนเต็ม 1–360 นาที";

test("limit constant", () => {
  assert.equal(DAILY_MINUTES_LIMIT, 360);
});

test("durationInputError", () => {
  assert.equal(durationInputError(""), REQUIRED);
  assert.equal(durationInputError(undefined), REQUIRED);
  for (const v of ["0", "361", "90.5", "90 นาที", -5, 1.5]) assert.equal(durationInputError(v), RANGE, String(v));
  for (const v of ["1", " 90 ", 360, "360"]) assert.equal(durationInputError(v), "", String(v));
});

test("parseDurationMinutes", () => {
  assert.equal(parseDurationMinutes(" 90 "), 90);
  assert.equal(parseDurationMinutes("361"), null);
});

test("roomDayMinutes", () => {
  assert.deepEqual(roomDayMinutes([]), { enforced: true, bookedMinutes: 0 });
  assert.deepEqual(roomDayMinutes([120, null, 300]), { enforced: false, bookedMinutes: 420 });
});

test("minutesRefusal new case boundary", () => {
  assert.equal(minutesRefusal([120, 120], undefined, 120), null);
  assert.deepEqual(minutesRefusal([120, 120], undefined, 121), { booked: 240, remaining: 120, requested: 121, over: 1, limit: 360 });
});

test("owner decision 5 example", () => {
  assert.deepEqual(minutesRefusal([100, 100, 100], undefined, 90), { booked: 300, remaining: 60, requested: 90, over: 30, limit: 360 });
});

test("old day not enforced (call A)", () => {
  assert.equal(minutesRefusal([300, null], undefined, 200), null);
});

test("call M edits", () => {
  assert.equal(minutesRefusal([300, 100], 50, 40), null);
  const r = minutesRefusal([300, 100], 50, 60);
  assert.ok(r);
  assert.equal(r.booked, 400);
  assert.equal(r.remaining, 0);
  assert.equal(r.requested, 60);
  assert.equal(r.over, 100);
  assert.equal(minutesRefusal([300, 300], null, 200), null);
});

test("minutesRefusalMessage", () => {
  assert.equal(
    minutesRefusalMessage({ booked: 300, remaining: 60, requested: 90, over: 30, limit: 360 }, "OR 17", "พฤ. 12 พ.ย. 2569"),
    "OR 17 พฤ. 12 พ.ย. 2569 ลงไว้แล้ว 300 นาที เหลือ 60 นาที เคสนี้ 90 นาที เกิน 30 นาที (เวลาผ่าตัดรวมต่อห้องต่อวันไม่เกิน 360 นาที)",
  );
});
