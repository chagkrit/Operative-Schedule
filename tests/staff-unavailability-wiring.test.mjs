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

test("staff unavailability API route enforces validation, overlap and confirmation", async () => {
  const route = await read("app/api/staff-unavailability/route.ts");
  assert.match(route, /requiresConfirmation: true/);
  assert.match(route, /confirmExistingBookings/);
  assert.match(route, /overlappingStaff/);
  assert.match(route, /findOverlappingStaff/);
  assert.match(route, /isStaffOption/);
  assert.match(route, /500/);
  assert.match(route, /affectedBookingView/);
  const exports = route.match(/^export .*$/gm) || [];
  assert.deepEqual(
    exports.map((line) => line.match(/export (?:async )?function (\w+)/)?.[1]),
    ["POST", "DELETE"],
  );
});

test("staff unavailability edit preserves created_by and created_at", async () => {
  const route = await read("app/api/staff-unavailability/route.ts");
  assert.match(route, /createdBy: existing\?\.createdBy/);
  assert.match(route, /createdAt: existing\?\.createdAt/);
});

test("affected booking mapper is shared by both routes", async () => {
  const mapper = await read("app/lib/affected-booking.ts");
  assert.match(mapper, /export function affectedBookingView/);
  const closures = await read("app/api/schedule-closures/route.ts");
  assert.match(closures, /affectedBookingView/);
  assert.doesNotMatch(closures, /function affectedBooking\(/);
});

test("client date pickers show staff unavailability", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const css = await read("app/globals.css");
  assert.match(app, /from "\.\/lib\/staff-unavailability"/);
  assert.match(app, /unavailableStaff: string\[\]/);
  assert.match(app, /staffUnavailability: StaffUnavailability\[\]/);
  assert.match(app, /"ไม่ว่าง"/);
  assert.match(app, /staff-unavailable-notice/);
  const moveStart = app.indexOf("const moveDates");
  assert.notEqual(moveStart, -1);
  assert.match(app.slice(moveStart, moveStart + 1200), /caseStaffStatus/);
  assert.match(app, /<option[^>]*disabled/);
  assert.match(css, /\.staff-unavailable-notice/);
});

test("staff unavailability manager is wired into the closures tab", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const css = await read("app/globals.css");
  assert.match(app, /\/api\/staff-unavailability/);
  assert.match(app, /วันที่ staff ไม่ว่าง/);
  assert.match(app, /ไม่พบ Staff ในรายชื่อ/);
  assert.match(app, /confirmExistingBookings/);
  assert.match(app, /confirm\([^)]*ลบวันที่ staff ไม่ว่าง/);
  assert.match(app, /ยืนยันและคงคิวเดิม \$\{pendingUnavailability/);
  assert.match(app, /overlappingStaff|payload\.error/);
  assert.match(css, /\.unavailability-manager/);
});

test("in-progress unavailability can be edited with its original past start", async () => {
  const route = await read("app/api/staff-unavailability/route.ts");
  const app = await read("app/SchedulerApp.tsx");
  assert.match(route, /startDate < today && !\(existing && startDate === existing\.startDate\)/);
  assert.match(route, /endDate < today/);
  assert.match(route, /startDate < today \? today : startDate/);
  assert.ok(route.indexOf("const existing") < route.indexOf("startDate < today &&"));
  assert.match(app, /editingOriginalStart/);
});

test("live clash badges are computed on render, not stored", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const css = await read("app/globals.css");
  assert.match(app, /function clashStaffFor\(/);
  assert.match(app, /ควรย้ายวัน/);
  assert.match(app, /has-clash/);
  assert.match(app, /<ClashBadge /);
  assert.match(app, /staffUnavailability=\{data\?\.staffUnavailability \|\| \[\]\}/);
  assert.match(css, /\.clash-badge/);
  assert.match(css, /\.month-day\.has-clash/);
});
