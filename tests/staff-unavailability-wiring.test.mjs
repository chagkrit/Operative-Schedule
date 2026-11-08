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
