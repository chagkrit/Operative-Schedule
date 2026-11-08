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

test("stores staff unavailability in Google Calendar", async () => {
  const calendar = await read("app/lib/calendar.ts");
  assert.match(calendar, /or_queue: "staff_unavailable"/);
  assert.match(calendar, /or_queue === "staff_unavailable"/);
  assert.match(calendar, /export type CalendarStaffUnavailability/);
  assert.match(calendar, /staffUnavailability/);
  assert.match(calendar, /export async function saveStaffUnavailabilityEvent/);
  assert.match(calendar, /export async function deleteStaffUnavailabilityEvent/);
  assert.match(calendar, /addDays\(entry\.endDate, 1\)/);
  assert.match(calendar, /addDays\(end, -1\)/);
});

test("staff unavailability ids are assigned by Google, not derived", async () => {
  const calendar = await read("app/lib/calendar.ts");
  const save = functionBody(calendar, "saveStaffUnavailabilityEvent");
  assert.doesNotMatch(save, /deterministicId/);
  assert.match(save, /method: "PATCH"/);
  assert.match(save, /method: "POST"/);
});

test("legacy calendar parsing still skips tagged events", async () => {
  const legacy = await read("app/lib/legacy-calendar.ts");
  assert.match(legacy, /extendedProperties\?\.private\?\.or_queue/);
});

test("queue enforces staff unavailability in destinationError", async () => {
  const queue = await read("app/lib/queue.ts");
  assert.match(queue, /unavailableStaff: string\[\]/);
  assert.match(queue, /staffUnavailability/);
  assert.match(queue, /unavailableStaffOn\(/);
  assert.match(queue, /caseStaffStatus/);
  assert.match(queue, /staffUnavailableMessage/);
  assert.match(queue, /export function staffBlockedOn/);
  assert.match(queue, /export function destinationError\([\s\S]*?staffMembers\?:/);
  assert.equal((queue.match(/unavailableStaff: unavailableStaffOn\(/g) || []).length, 3);
  const start = queue.indexOf("export function destinationError");
  const body = queue.slice(start);
  const closed = body.indexOf("if (day.closed)");
  const staff = body.indexOf("caseStaffStatus(");
  const capacity = body.indexOf("day.count >= day.capacity");
  assert.ok(closed !== -1 && closed < staff && staff < capacity, "staff check between closed and capacity");
});

test("booking route enforces staff unavailability", async () => {
  const route = await read("app/api/schedule/route.ts");
  assert.doesNotMatch(route, /destinationError\(\{ isCancer \}, /);
  assert.equal((route.match(/destinationError\(\{ isCancer, staffMembers \}, /g) || []).length, 4);
  assert.match(route, /staffBlockedOn\(staffMembers, verifiedDay\)/);
  assert.match(route, /staffUnavailableMessage\(verifiedDay\.unavailableStaff\)/);
  assert.match(route, /closures,\s*staffUnavailability,/);
  const verify = route.indexOf("staffBlockedOn(staffMembers, verifiedDay)");
  assert.match(route.slice(verify, verify + 200), /deleteBookingEvent/);
});

test("move route re-checks staff unavailability after the write", async () => {
  const route = await read("app/api/cases/[id]/move/route.ts");
  assert.match(route, /staffBlockedOn\(booking\.staffMembers, verifiedDay\)/);
  const verify = route.indexOf("staffBlockedOn(booking.staffMembers, verifiedDay)");
  assert.match(route.slice(verify, verify + 200), /restoreCalendarBooking/);
  assert.match(route, /destinationError\(booking, destination\)/);
});
