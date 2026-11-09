import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function functionBody(source, name) {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} not found`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("calendar stores duration_minutes on create, move, restore and update", async () => {
  const calendar = await read("app/lib/calendar.ts");
  for (const name of ["createBookingEvent", "restoreCalendarBooking"]) {
    assert.match(functionBody(calendar, name), /duration_minutes/, `${name} must write duration_minutes`);
  }
  for (const name of ["moveCalendarBooking", "updateBookingDuration"]) {
    assert.match(functionBody(calendar, name), /patchBookingEvent/, `${name} must write through patchBookingEvent`);
  }
  const start = calendar.indexOf("function bookingPrivateData");
  assert.notEqual(start, -1, "bookingPrivateData not found");
  const helper = calendar.slice(start, calendar.indexOf("\n}\n", start));
  assert.match(helper, /duration_minutes: booking\.durationMinutes === null \? "" : String\(booking\.durationMinutes\)/);
  assert.match(calendar, /ระยะเวลาผ่าตัด: /);
  assert.match(calendar, /export async function updateBookingDuration/);
  assert.match(calendar, /durationMinutes: number \| null/);
  assert.match(calendar, /parseDurationMinutes/);
});

test("queue summarises booked minutes per room-day", async () => {
  const queue = await read("app/lib/queue.ts");
  assert.match(queue, /bookedMinutes/);
  assert.match(queue, /minutesEnforced/);
  assert.match(queue, /export function roomDayDurations/);
  assert.match(queue, /roomDayMinutes/);
});

test("legacy calendar events have no duration", async () => {
  const legacy = await read("app/lib/legacy-calendar.ts");
  assert.match(legacy, /durationMinutes: null/);
});
