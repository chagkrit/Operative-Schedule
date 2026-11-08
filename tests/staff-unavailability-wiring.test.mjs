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
  const rules = await read("app/lib/destination.ts");
  assert.match(queue, /unavailableStaff: string\[\]/);
  assert.match(queue, /staffUnavailability/);
  assert.match(queue, /unavailableStaffOn\(/);
  assert.match(queue, /export \{ destinationError, staffBlockedOn \} from "\.\/destination"/);
  assert.equal((queue.match(/unavailableStaff: unavailableStaffOn\(/g) || []).length, 3);
  assert.match(rules, /export function staffBlockedOn/);
  assert.match(rules, /export function destinationError\([\s\S]*?staffMembers\?:/);
  // destination.ts must stay free of Calendar/auth imports so tests can load it
  assert.doesNotMatch(rules, /from "[^"]*(calendar|auth)"/);
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

test("calendar selected-day booking cards carry the clash badge", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const start = app.indexOf("selectedBookings.map(");
  assert.notEqual(start, -1);
  const end = app.indexOf("</article>", start);
  assert.match(app.slice(start, end), /<ClashBadge booking=\{booking\} entries=\{staffUnavailability\} \/>/);
});

test("final wave: move picker lists staff-blocked days as disabled options", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /const moveOptionDays = useMemo/);
  assert.match(app, /moveOptionDays\.map\(/);
  assert.match(app, /disabled>\{displayDate\(day\.date, true\)\} · \{day\.queueType === "EXTRA" \? "OR Extra" : "OR 17"\} · ไม่ว่าง:/);
  assert.match(app, /const moveDates = useMemo/);
});

test("final wave: phone floor covers the new unavailability UI", async () => {
  const css = await read("app/mobile-shell.css");
  const phone = css.slice(css.indexOf("max-width: 650px"));
  for (const selector of [".clash-badge", ".month-unavailable-summary", ".staff-unavailable-notice", ".unavailability-detail small", ".unavailability-list > p", ".unavailability-staff label", ".unavailability-heading small"]) {
    assert.ok(phone.includes(selector), `${selector} missing from 12px floor`);
  }
  assert.ok(phone.includes(".month-day .clash-flag"), "clash-flag missing from 10px floor");
  assert.ok(phone.includes('.unavailability-form input[type="date"]'), "date input missing from 16px list");
  assert.ok(phone.includes(".unavailability-form textarea"), "textarea missing from 16px list");
  const globals = await read("app/globals.css");
  assert.match(globals, /\.clash-badge \{[^}]*font-size: 11px/);
  assert.match(globals, /\.month-day \.clash-flag \{[^}]*font-size: 9px/);
});

test("final wave: blocked selected date disables save", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /selectedStaffNotice\?\.blocked/);
  assert.match(app, /เลือกวันอื่น/);
  assert.match(app, /disabled=\{saving \|\| Boolean\(selectedStaffNotice\?\.blocked\)\}/);
});

test("final wave: ClashBadge has no status role and past cases never clash", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.doesNotMatch(app, /className="clash-badge" role="status"/);
  assert.match(app, /if \(booking\.scheduleDate < bangkokToday\(\)\) return \[\];/);
});

test("final wave: editing an unavailability entry focuses the form", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /unavailabilityStartRef = useRef<HTMLInputElement>/);
  assert.match(app, /ref=\{unavailabilityStartRef\}/);
  assert.match(app, /ref=\{unavailabilityFormRef\}/);
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.match(app, /unavailabilityStartRef\.current\?\.focus\(/);
});

test("final wave: STAFF in the client equals STAFF_OPTIONS", async () => {
  const names = (source, marker) => {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `${marker} not found`);
    const block = source.slice(start, source.indexOf("]", start));
    return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  const client = names(await read("app/SchedulerApp.tsx"), "const STAFF = [");
  const lib = names(await read("app/lib/schedule.ts"), "export const STAFF_OPTIONS = [");
  assert.ok(client.length > 0);
  assert.deepEqual(client, lib);
});

test("final wave: overlap error tells the user to edit the existing entry", async () => {
  const route = await read("app/api/staff-unavailability/route.ts");
  assert.match(route, /มีวันที่ไม่ว่างทับซ้อนกับช่วงวันที่เลือกแล้ว กรุณาแก้ไขรายการเดิม/);
});

test("unauthenticated Calendar calls answer 401 instead of 500", async () => {
  const calendar = await read("app/lib/calendar.ts");
  assert.match(calendar, /withStatus\("กรุณาเข้าสู่ระบบด้วย hnbcmu@gmail\.com", 401\)/);
  assert.match(calendar, /withStatus\("สิทธิ์ Google Calendar หมดอายุ กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่", 401\)/);
  assert.doesNotMatch(calendar, /throw new Error\("กรุณาเข้าสู่ระบบด้วย/);
});

test("staff-unavailability POST rejects malformed bodies with 400", async () => {
  const route = await read("app/api/staff-unavailability/route.ts");
  const post = functionBody(route, "POST");
  assert.match(post, /request\.json\(\)\.catch\(\(\) => null\)/);
  assert.match(post, /typeof value === "string"/);
  assert.match(post, /ข้อมูลที่ส่งมาไม่ถูกต้อง/);
  assert.doesNotMatch(post, /payload\.\w+\?\.trim\(\)/);
});

test("every modal dialog traps Tab, not only the delete dialog", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /event\.key === "Tab"\) \{/);
  assert.doesNotMatch(app, /event\.key === "Tab" && deleteDialog/);
  assert.match(app, /querySelector<HTMLElement>\('\[role="dialog"\]\[aria-modal="true"\]/);
});

test("extra-days route uses the error status and rejects malformed bodies", async () => {
  const route = await read("app/api/extra-days/route.ts");
  assert.doesNotMatch(route, /\{ status: 500 \}/);
  assert.equal((route.match(/\(error as \{ status\?: number \}\)\.status \|\| 500/g) || []).length, 2);
  assert.match(functionBody(route, "POST"), /request\.json\(\)\.catch\(\(\) => null\)/);
});

test("staff-unavailability POST re-verifies after writing and undoes a raced save", async () => {
  const post = functionBody(await read("app/api/staff-unavailability/route.ts"), "POST");
  assert.match(post, /conflictingEntries\(verified\.staffUnavailability/);
  assert.doesNotMatch(post, /yieldsToConcurrentEntry/);
  assert.match(post, /conflictingEntries\([^)]*entry\.id\)\.length > 0/);
  assert.match(post, /ระบบไม่ได้บันทึกรายการใดในคำขอนี้/);
  assert.match(post, /ระบบคืนค่าการแก้ไขนี้แล้ว/);
  // edit path restores the previous range (guarded by our etag) instead of deleting the entry
  assert.match(post, /startDate: existing!\.startDate,\s+endDate: existing!\.endDate/);
  assert.match(post, /ifMatch: await ifMatchForRestore\(request, existing!\.id, entries\[0\]\?\.etag \|\| ""/);
  assert.match(post, /undoCalendarWrite\(/);
  // an unverifiable save is undone (fail closed), not kept with a 500
  assert.match(post, /verified = await listCalendarData\(request, today, horizonEnd\);\s+\} catch \{\s+const \{ outcome, restoredClash \} = await undoAndCheck\(\);/);
});

test("booking: a concrete refusal for the chosen day wins over the same_staff hint", async () => {
  const route = await read("app/api/schedule/route.ts");
  const selectedAt = route.indexOf("const error = selectedDayError");
  const sameStaffAt = route.indexOf("ไม่พบคิวว่างที่ Staff ที่เลือกมีเคสอยู่แล้ว กรุณาเลือกห้องไหนก็ได้");
  assert.ok(selectedAt !== -1 && sameStaffAt > selectedAt);
});

test("move button is disabled when the chosen destination went stale after a Sync", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /const moveTargetStale = Boolean\(selectedCase && moveTarget && !moveTargetDay\)/);
  assert.match(app, /<button type="submit" disabled=\{moving \|\| !moveTargetDay\}>/);
  assert.doesNotMatch(app, /disabled=\{moving \|\| !moveTarget\}/);
  assert.match(app, /if \(!selectedCase \|\| !moveTarget \|\| !moveTargetDay\)/);
  assert.match(app, /moveTargetMissing && <option value=\{moveTarget\} disabled>/);
  assert.match(app, /วันที่เลือกใช้ย้ายไม่ได้แล้ว/);
});

test("calendar save supports an If-Match guard and returns the etag", async () => {
  const save = functionBody(await read("app/lib/calendar.ts"), "saveStaffUnavailabilityEvent");
  assert.match(save, /options: \{ ifMatch\?: string \} = \{\}/);
  assert.match(save, /"if-match": options\.ifMatch/);
  assert.match(save, /Promise<\{ id: string; etag: string \}>/);
});

test("low findings: restored range is re-checked and a failed create cleanup is reported", async () => {
  const post = functionBody(await read("app/api/staff-unavailability/route.ts"), "POST");
  assert.match(post, /const restoredRangeClash = async \(\) =>/);
  assert.match(post, /conflictingEntries\(after\.staffUnavailability, existing\.staff, existing, existing\.id\)/);
  assert.match(post, /\(await undoWrite\(\)\) === "failed"/);
  assert.match(post, /ลบรายการที่บันทึกไปแล้วบางส่วนไม่สำเร็จ/);
  assert.match(post, /outcome === "uncertain"/);
});

test("restore without our own etag only proceeds if the event still holds what we wrote", async () => {
  const calendar = await read("app/lib/calendar.ts");
  const guard = functionBody(calendar, "ifMatchForRestore");
  assert.match(guard, /if \(writtenEtag\) return writtenEtag;/);
  assert.match(guard, /getEventVersion\(request, id\)/);
  assert.match(guard, /withStatus\("รายการถูกแก้ไขโดยผู้อื่นระหว่างบันทึก", 412\)/);
  assert.match(functionBody(calendar, "getEventVersion"), /status === 404 \|\| status === 410/);
});

test("schedule closure save re-verifies the date and undoes a raced save", async () => {
  const route = await read("app/api/schedule-closures/route.ts");
  const post = functionBody(route, "POST");
  assert.match(post, /verifiedClosures = \(await listCalendarData\(request, date, date\)\)\.closures/);
  assert.match(post, /closure\.date === date && closure\.id !== closureId/);
  assert.match(post, /undoCalendarWrite\(/);
  assert.match(post, /ifMatchForRestore\(request, existing!\.id, saved\.etag/);
  assert.match(post, /มีผู้บันทึกวันปิดรับคิวในวันที่นี้พร้อมกัน/);
  const save = functionBody(await read("app/lib/calendar.ts"), "saveScheduleClosureEvent");
  assert.match(save, /"if-match": options\.ifMatch/);
});

test("engines require a Node that runs the test suite (registerHooks + type stripping)", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(pkg.engines.node, ">=22.18.0");
});

test("creating a closure never overwrites a moved closure that still holds the per-date id", async () => {
  const save = functionBody(await read("app/lib/calendar.ts"), "saveScheduleClosureEvent");
  const guard = save.indexOf("if (await getEventVersion(request, id))");
  const put = save.indexOf('method: "PUT"');
  assert.ok(guard !== -1 && guard < put, "check the id holder before PUT");
  assert.match(save, /body: JSON\.stringify\(fields\)/);
});
