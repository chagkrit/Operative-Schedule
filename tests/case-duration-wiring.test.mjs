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

test("booking route enforces the 360-minute room-day limit", async () => {
  const route = await read("app/api/schedule/route.ts");
  assert.match(route, /durationInputError\(/);
  assert.ok((route.match(/minutesRefusal\(/g) || []).length >= 2, "pre-write filter and post-write re-check");
  assert.match(route, /reason: "minutes_exceeded"/);
  assert.match(route, /roomDayDurations\(verified\.bookings, selected\.date, selected\.queueType, id\)/);
  assert.match(route, /durationMinutes,/);
  const recheck = route.slice(route.indexOf("roomDayDurations(verified.bookings"));
  assert.match(recheck.slice(0, recheck.indexOf("status: 409")), /deleteBookingEvent\(request, id\)/);
});

test("move route checks minutes on the destination and re-checks after the write", async () => {
  const move = await read("app/api/cases/[id]/move/route.ts");
  assert.match(move, /durationMinutes/);
  assert.ok((move.match(/minutesRefusal\(/g) || []).length >= 2, "pre-write and post-write minutesRefusal");
  assert.match(move, /reason: "minutes_exceeded"/);
  assert.match(move, /restoreCalendarBooking\(/);
});

test("PATCH /api/cases/[id] edits duration with checks and rollback", async () => {
  const route = await read("app/api/cases/[id]/route.ts");
  assert.match(route, /export async function PATCH/);
  assert.match(route, /updateBookingDuration\(/);
  assert.ok((route.match(/minutesRefusal\(/g) || []).length >= 2, "pre-write and post-write minutesRefusal");
  assert.match(route, /restoreCalendarBooking\(/);
  assert.match(route, /เคสนี้นำเข้าจาก Google Calendar โดยตรง กรุณาสลับวันเพื่อใส่ระยะเวลา/);
});

test("search results include durationMinutes", async () => {
  assert.match(await read("app/api/cases/search/route.ts"), /durationMinutes/);
});

test("client UI: duration field, remaining minutes, edit dialog and 360 popup", async () => {
  const ui = await read("app/SchedulerApp.tsx");
  assert.match(ui, /const EMPTY_FORM = \{[\s\S]*?durationMinutes: ""/);
  assert.match(ui, /ระยะเวลาผ่าตัด \(นาที\)/);
  assert.match(ui, /value=\{form\.durationMinutes\}[^\n]*inputMode="numeric"/);
  assert.match(ui, /durationInputError\(form\.durationMinutes\)/);
  assert.match(ui, /minutesEnforced[\s\S]{0,200}เหลือ[\s\S]{0,80}นาที/);
  assert.match(ui, /ใช้ไป [\s\S]{0,60}นาที/);
  assert.match(ui, /fetch\(`\/api\/cases\/\$\{[^}]+\}`, \{\s*method: "PATCH"[\s\S]{0,200}durationMinutes/);
  assert.match(ui, /แก้ระยะเวลา/);
  assert.match(ui, /type BookingConflict = \{[^}]*heading\?: string/);
  assert.equal((ui.match(/reason === "minutes_exceeded"/g) || []).length >= 3, true, "submitBooking, moveCase, edit handler");
  assert.ok((ui.match(/setBookingConflict\(\{\s*heading/g) || []).length >= 3);
  for (const heading of ["ลงคิวไม่ได้: เวลาผ่าตัดรวมเกิน 360 นาที", "สลับวันไม่ได้: เวลาผ่าตัดรวมเกิน 360 นาที", "แก้ระยะเวลาไม่ได้: เวลาผ่าตัดรวมเกิน 360 นาที"]) {
    assert.ok(ui.includes(heading), heading);
  }
  assert.match(ui, /bookingConflict\.heading/);
  assert.match(ui, /minutesRefusalMessage\(/);
  assert.match(ui, /minutesRefusal\(/);
});

test("waiting-time export has a duration column after Operation", async () => {
  const route = await read("app/api/wait-time-export/route.ts");
  assert.match(route, /value: "Operation"[^\n]*\n\s*\{ value: "ระยะเวลาผ่าตัด \(นาที\)"/);
  assert.match(route, /booking\.durationMinutes \?\? ""/);
});

test("minutes 409 body names the day and room; popup is a single OK for kind minutes", async () => {
  const route = await read("app/api/schedule/route.ts");
  assert.match(route, /reason: "minutes_exceeded",\s*date,\s*queueType,/);
  const ui = await read("app/SchedulerApp.tsx");
  assert.match(ui, /kind\?: "minutes"/);
  assert.equal((ui.match(/kind: "minutes"/g) || []).length, 3, "book, move, edit");
  assert.match(ui, /payload\.date \? displayDate\(payload\.date, true\)/);
  assert.match(ui, /payload\.queueType \|\|/);
  assert.match(ui, /bookingConflict\.kind !== "minutes" && <h3/);
  assert.match(ui, /bookingConflict\.kind === "minutes" \? \(\s*<button[\s\S]{0,80}>ตกลง<\/button>/);
  assert.match(ui, /editDialog\.error && <p id="edit-duration-error" role="alert">/);
});
