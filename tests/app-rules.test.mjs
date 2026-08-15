import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("protects the app with the exact authorized Google account", async () => {
  const auth = await read("auth.ts");
  assert.match(auth, /AUTHORIZED_EMAIL = "hnbcmu@gmail\.com"/);
  assert.match(auth, /profile\.email\?\.toLowerCase\(\) === AUTHORIZED_EMAIL/);
  assert.match(auth, /calendar\.events/);
});

test("keeps the clinical queue safeguards in the server API", async () => {
  const route = await read("app/api/schedule/route.ts");
  const queue = await read("app/lib/queue.ts");
  const schedule = await read("app/lib/schedule.ts");
  assert.match(queue, /day\.count === 3 && day\.cancerCount === 0/);
  assert.match(queue, /ช่องสุดท้ายของวันนี้รับ Cancer เท่านั้น/);
  assert.match(queue, /OR Extra รับเฉพาะเคส Cancer/);
  assert.match(route, /cancerSchedulingMode === "specific"/);
  assert.match(route, /cancerSchedulingMode === "earliest"/);
  assert.match(schedule, /ca\\s\+\(breast\|thyroid\)/i);
  assert.match(schedule, /dcis/i);
});

test("supports direct Google Calendar sync and secure production cookies", async () => {
  const calendar = await read("app/lib/calendar.ts");
  const app = await read("app/SchedulerApp.tsx");
  assert.match(calendar, /secureCookie: new URL\(request\.url\)\.protocol === "https:"/);
  assert.match(app, /Sync ทันที/);
  assert.match(app, /CA breast, CA thyroid/);
  assert.match(app, /cancerSchedulingMode === "specific"/);
});

test("imports legacy Calendar cases without duplicating tagged events", async () => {
  const legacy = await read("app/lib/legacy-calendar.ts");
  const calendar = await read("app/lib/calendar.ts");
  const route = await read("app/api/schedule/route.ts");
  assert.match(legacy, /\\d\{6,8\}/);
  assert.match(legacy, /importedFromCalendar: true/);
  assert.match(legacy, /or_queue/);
  assert.match(calendar, /bookingFromEvent\(event\) \|\| parseLegacyCalendarEvent\(event\)/);
  assert.match(route, /importedCount/);
});

test("maps legacy English Staff initials exactly as the OR team defines", async () => {
  const legacy = await read("app/lib/legacy-calendar.ts");
  assert.match(legacy, /A: "อ อารีวรรณ"/);
  assert.match(legacy, /K: "อ กีรติ"/);
  assert.match(legacy, /P: "อ ปัญจพร"/);
  assert.match(legacy, /C: "อ จักรกริช"/);
  assert.match(legacy, /J: "อ จุฬารัตน์"/);
  assert.match(legacy, /N: "อ ณิชกานต์"/);
  assert.doesNotMatch(legacy, /G: "อ กีรติ"/);
  assert.match(legacy, /(?:อ\\\.\?\\s\+)?\(\[AKPCJN\]\)/);
  assert.match(legacy, /legacyStaffFromPrefix\(beforeHn\)/);
});

test("creates timed Calendar slots and assigns colors by Staff", async () => {
  const calendar = await read("app/lib/calendar.ts");
  assert.match(calendar, /startHour = 7 \+ Math\.max\(1, slotNo\)/);
  assert.match(calendar, /timeZone: "Asia\/Bangkok"/);
  assert.match(calendar, /"อ อารีวรรณ": "5"/);
  assert.match(calendar, /"อ กีรติ": "10"/);
  assert.match(calendar, /"อ ปัญจพร": "4"/);
  assert.match(calendar, /"อ จักรกริช": "9"/);
  assert.match(calendar, /"อ จุฬารัตน์": "3"/);
  assert.match(calendar, /"อ ณิชกานต์": "6"/);
  assert.match(calendar, /colorId: staffEventColor\(booking\.staff\)/);
  assert.match(calendar, /colorId: staffEventColor\(moved\.staff\)/);
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /displaySlotTime\(row\.slotNo\)/);
});

test("disables Google Calendar reminders for booking writes", async () => {
  const calendar = await read("app/lib/calendar.ts");
  assert.ok(
    (calendar.match(/reminders: \{ useDefault: false, overrides: \[\] \}/g) || []).length >= 3,
    "create, move, and restore must all disable event reminders",
  );
  assert.ok(
    (calendar.match(/\?sendUpdates=none/g) || []).length >= 3,
    "booking writes must not email attendees",
  );
});

test("searches cases and records verified calendar moves", async () => {
  const calendar = await read("app/lib/calendar.ts");
  const moveRoute = await read("app/api/cases/[id]/move/route.ts");
  const app = await read("app/SchedulerApp.tsx");
  assert.match(calendar, /privateExtendedProperty: `or_queue=\$\{tag\}`/);
  assert.match(calendar, /last_move_from/);
  assert.match(calendar, /last_move_to/);
  assert.match(app, /HN ชื่อ หรือสกุล/);
  assert.match(moveRoute, /destinationError/);
  assert.match(moveRoute, /restoreCalendarBooking/);
  assert.match(moveRoute, /verifiedDay\.count > verifiedDay\.capacity/);
});

test("supports manual surgery dates and shows the calculated waiting time", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const route = await read("app/api/schedule/route.ts");
  assert.match(app, /dateEntryMode: "list" as "list" \| "manual"/);
  assert.match(app, /ระบุวันเอง/);
  assert.match(app, /type="date" min=\{manualDateStart\}/);
  assert.doesNotMatch(app, /type="date" min=\{manualDateStart\} max=/);
  assert.match(app, /ไม่จำกัดช่วงเวลา/);
  assert.match(app, /daysBetween\(bangkokToday\(\), selectedSurgeryDate\)/);
  assert.match(app, /ระยะเวลารอคิว/);
  assert.match(app, /OR 17/);
  assert.match(route, /const scheduleFrom = hasSpecificDate \? requestedDate : today/);
  assert.match(route, /const scheduleTo = hasSpecificDate \? addDays\(requestedDate, 365\) : addDays\(today, 120\)/);
  assert.match(route, /requestedDate < today/);
});

test("keeps OR Extra at four cases and exposes a monthly count calendar", async () => {
  const extraRoute = await read("app/api/extra-days/route.ts");
  const calendar = await read("app/lib/calendar.ts");
  const queue = await read("app/lib/queue.ts");
  const app = await read("app/SchedulerApp.tsx");
  assert.match(extraRoute, /const capacity = 4/);
  assert.doesNotMatch(extraRoute, /capacity < 1 \|\| capacity > 8/);
  assert.match(calendar, /date, capacity: 4/);
  assert.match(queue, /queueType: "EXTRA",\s+capacity: 4/);
  assert.match(app, /ปฏิทินรายเดือน/);
  assert.match(app, /selectedCount/);
  assert.match(app, /ลงแล้ว \{day\.count\}\/\{day\.capacity\} เคส/);
  assert.match(app, /booking\.scheduleDate === selectedDate/);
  assert.match(app, /เคสที่ลงคิวแล้ว/);
  assert.match(app, /booking\.patientName/);
  assert.match(app, /displaySlotTime\(booking\.slotNo\)/);
  assert.match(app, /ไม่สามารถเปลี่ยนได้/);
  assert.doesNotMatch(app, /type="number" min="1" max="8"/);
});

test("filters available OR rooms by the selected Staff when requested", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const route = await read("app/api/schedule/route.ts");
  assert.match(app, /staffQueuePreference: "any" as "same_staff" \| "any"/);
  assert.match(app, /ห้องที่ Staff มีเคสแล้ว/);
  assert.match(app, /ห้องไหนก็ได้ที่ยังว่าง/);
  assert.match(app, /booking\.staff === form\.staff/);
  assert.match(app, /staffDayKeys\.has\(`\$\{day\.date\}:\$\{day\.queueType\}`\)/);
  assert.match(route, /staffQueuePreference === "any" \|\| staffDayKeys\.has/);
  assert.match(route, /booking\.staff === staff/);
  assert.match(route, /ไม่พบคิวว่างที่ \$\{staff\} มีเคสอยู่แล้ว/);
});

test("shows a conflict popup and suggests valid alternative OR dates", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const route = await read("app/api/schedule/route.ts");
  assert.match(app, /role="dialog" aria-modal="true"/);
  assert.match(app, /กรุณาเลือกคิวใหม่/);
  assert.match(app, /คิวที่ว่างและตรงเกณฑ์/);
  assert.match(app, /chooseSuggestedQueue/);
  assert.match(app, /response\.status === 409/);
  assert.match(route, /addDays\(requestedDate, 365\)/);
  assert.match(route, /matchesClinicalRules/);
  assert.match(route, /suggestions: alternativeDays/);
  assert.match(route, /availableSlots: day\.capacity - day\.count/);
});

test("starts manual dates after the last dropdown option and prompts Calendar sync", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const scheduleRoute = await read("app/api/schedule/route.ts");
  const presenceRoute = await read("app/api/presence/route.ts");
  assert.match(app, /const manualDateStart = useMemo/);
  assert.match(app, /dropdownDays\.at\(-1\)\?\.date/);
  assert.match(app, /min=\{manualDateStart\}/);
  assert.match(app, /วันถัดจากคิวว่างสุดท้ายใน Drop-down/);
  assert.match(app, /กด Sync ทันที เพื่อบันทึกลงใน Calendar/);
  assert.match(app, /ขณะนี้มีเครื่องที่ log in เข้าระบบอยู่/);
  assert.match(scheduleRoute, /dateEntryMode === "manual"/);
  assert.match(scheduleRoute, /requestedDate < manualMinDate/);
  assert.match(scheduleRoute, /วันถัดจากคิวว่างสุดท้ายใน Drop-down/);
  assert.match(presenceRoute, /PRESENCE_TTL_MS = 90_000/);
  assert.match(presenceRoute, /orQueueActiveDevices/);
});
