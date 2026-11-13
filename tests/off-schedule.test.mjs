import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "./ts-resolve.mjs";

const { offScheduleRoomDays, OFF_SCHEDULE_NOTE } = await import("../app/lib/off-schedule.ts");
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("an OR 17 booking moved to a day without an OR 17 room-day gets its own room-day", () => {
  const bookings = [
    { scheduleDate: "2026-11-16", queueType: "OR17" }, // Monday: no OR 17 day
    { scheduleDate: "2026-11-16", queueType: "OR17" },
    { scheduleDate: "2026-11-17", queueType: "OR17" }, // Tuesday: exists
  ];
  const existing = new Set(["2026-11-17:OR17"]);
  assert.deepEqual(offScheduleRoomDays(bookings, existing), [{ date: "2026-11-16", queueType: "OR17" }]);
});

test("EXTRA bookings are left to the existing legacy-extra path", () => {
  assert.deepEqual(offScheduleRoomDays([{ scheduleDate: "2026-11-16", queueType: "EXTRA" }], new Set()), []);
});

test("results are sorted by date", () => {
  const bookings = [
    { scheduleDate: "2026-11-23", queueType: "OR17" },
    { scheduleDate: "2026-11-16", queueType: "OR17" },
  ];
  assert.deepEqual(offScheduleRoomDays(bookings, new Set()).map((day) => day.date), ["2026-11-16", "2026-11-23"]);
});

test("schedule builds off-schedule room-days as full, flagged, and the list shows a warning", async () => {
  const queue = await read("app/lib/queue.ts");
  const app = await read("app/SchedulerApp.tsx");
  assert.match(queue, /offScheduleRoomDays\(/);
  assert.match(queue, /offSchedule: true/);
  assert.match(queue, /summary\.offSchedule\) summary\.capacity = summary\.count/);
  assert.match(app, /day\.offSchedule && <p className="warning-line">/);
  assert.equal(OFF_SCHEDULE_NOTE, "ย้ายใน Google Calendar • นอกวันปกติ");
});
