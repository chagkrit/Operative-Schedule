import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("protects the app with the exact authorized Google account", async () => {
  const auth = await read("auth.ts");
  const signIn = await read("app/signin/page.tsx");
  assert.match(auth, /AUTHORIZED_EMAIL = "hnbcmu@gmail\.com"/);
  assert.match(auth, /profile\.email\?\.toLowerCase\(\) === AUTHORIZED_EMAIL/);
  assert.match(auth, /calendar\.events/);
  assert.doesNotMatch(signIn, /อนุญาตเฉพาะบัญชี/);
  assert.doesNotMatch(signIn, /hnbcmu@gmail\.com/);
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

test("stores an optional booking note from the Operation form in Google Calendar", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const route = await read("app/api/schedule/route.ts");
  const calendar = await read("app/lib/calendar.ts");
  assert.match(app, /<span>หมายเหตุ<\/span><textarea/);
  assert.match(app, /updateField\("note", e\.target\.value\)/);
  assert.match(route, /const note = String\(payload\.note \|\| ""\)\.trim\(\)/);
  assert.match(route, /note\.length > 1000/);
  assert.match(calendar, /note: data\.note \|\| ""/);
  assert.match(calendar, /หมายเหตุ: \$\{booking\.note \|\| "-"\}/);
  assert.match(calendar, /note: booking\.note/);
  assert.match(calendar, /note: moved\.note/);
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

test("keeps single-Staff Calendar events compatible while storing new team memberships", async () => {
  const calendar = await read("app/lib/calendar.ts");
  const legacy = await read("app/lib/legacy-calendar.ts");
  assert.match(calendar, /JSON\.parse\(data\.staff_members \|\| "\[\]"\)/);
  assert.match(calendar, /return legacyStaff \? \[legacyStaff\] : \[\]/);
  assert.match(legacy, /staffMembers: staff === "ไม่ระบุ" \? \[\] : \[staff\]/);
  assert.match(calendar, /staff_members: JSON\.stringify\(moved\.staffMembers\)/);
  assert.match(calendar, /staff_members: JSON\.stringify\(booking\.staffMembers\)/);
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

test("creates timed Calendar slots and assigns colors by the primary Staff member", async () => {
  const calendar = await read("app/lib/calendar.ts");
  assert.match(calendar, /startHour = 7 \+ Math\.max\(1, slotNo\)/);
  assert.match(calendar, /timeZone: "Asia\/Bangkok"/);
  assert.match(calendar, /"อ อารีวรรณ": "5"/);
  assert.match(calendar, /"อ กีรติ": "10"/);
  assert.match(calendar, /"อ ปัญจพร": "4"/);
  assert.match(calendar, /"อ จักรกริช": "9"/);
  assert.match(calendar, /"อ จุฬารัตน์": "3"/);
  assert.match(calendar, /"อ ณิชกานต์": "6"/);
  assert.match(calendar, /staff_members: JSON\.stringify\(booking\.staffMembers\)/);
  assert.match(calendar, /staff: booking\.staffMembers\[0\] \|\| ""/);
  assert.match(calendar, /colorId: staffEventColor\(booking\.staffMembers\)/);
  assert.match(calendar, /colorId: staffEventColor\(moved\.staffMembers\)/);
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
  assert.match(moveRoute, /verifiedDay\.closed \|\| verifiedDay\.count > verifiedDay\.capacity/);
});

test("supports manual surgery dates and shows the calculated waiting time", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const route = await read("app/api/schedule/route.ts");
  assert.match(app, /dateEntryMode: "list" as "list" \| "manual"/);
  assert.match(app, /ระบุวันเอง/);
  assert.match(app, /type="date" min=\{manualDateStart\} max=\{data\?\.horizonEnd\}/);
  assert.doesNotMatch(app, /ไม่จำกัดช่วงเวลา/);
  assert.match(app, /daysBetween\(queuedDate, selectedSurgeryDate\)/);
  assert.match(app, /ระยะเวลารอคิว/);
  assert.match(app, /OR 17/);
  assert.match(route, /const scheduleFrom = hasSpecificDate \? requestedDate : today/);
  assert.match(route, /const scheduleTo = horizonEnd/);
  assert.match(route, /requestedDate < today/);
  assert.match(route, /requestedDate > horizonEnd/);
});

test("persists queued dates and exports de-identified surgical waiting-time data", async () => {
  const calendar = await read("app/lib/calendar.ts");
  const legacy = await read("app/lib/legacy-calendar.ts");
  const scheduleRoute = await read("app/api/schedule/route.ts");
  const exportRoute = await read("app/api/wait-time-export/route.ts");
  const xlsx = await read("app/lib/xlsx.ts");
  const app = await read("app/SchedulerApp.tsx");
  assert.match(calendar, /queuedDate: data\.queued_date \|\| calendarTimestampDate\(event\.created\) \|\| date/);
  assert.match(calendar, /queued_date: booking\.queuedDate/);
  assert.match(calendar, /queued_date: moved\.queuedDate/);
  assert.match(calendar, /วันที่ลงคิว: \$\{booking\.queuedDate\}/);
  assert.match(calendar, /ระยะเวลารอผ่าตัด: \$\{daysBetween\(booking\.queuedDate, booking\.scheduleDate\)\} วัน/);
  assert.match(legacy, /queuedDate: calendarTimestampDate\(event\.created\) \|\| scheduleDate/);
  assert.match(scheduleRoute, /queuedDate: today/);
  assert.match(exportRoute, /listCalendarData\(request, from, to\)/);
  assert.match(exportRoute, /"ระยะเวลารอผ่าตัด \(วัน\)"/);
  assert.match(exportRoute, /createWaitingTimeWorkbook\(rows\)/);
  assert.match(exportRoute, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.match(xlsx, /\[Content_Types\]\.xml/);
  assert.doesNotMatch(exportRoute, /booking\.hn|booking\.firstName|booking\.lastName|booking\.phone/);
  assert.match(app, /Export Excel เวลารอผ่าตัด/);
  assert.match(app, /\/api\/wait-time-export\?from=/);
  assert.match(app, /นับจากวันที่ลงคิว/);
});

test("records neoadjuvant treatment through Calendar, moves, and Excel export", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const route = await read("app/api/schedule/route.ts");
  const calendar = await read("app/lib/calendar.ts");
  const legacy = await read("app/lib/legacy-calendar.ts");
  const exportRoute = await read("app/api/wait-time-export/route.ts");
  assert.match(app, /neoadjuvantTreatment: false/);
  assert.match(app, /เคยได้รับการรักษาแบบ neoadjuvant มาก่อน/);
  assert.match(app, /Export Excel/);
  assert.match(route, /const neoadjuvantTreatment = payload\.neoadjuvantTreatment === true/);
  assert.match(route, /neoadjuvantTreatment,/);
  assert.match(calendar, /neoadjuvantTreatment: data\.neoadjuvant_treatment === "true"/);
  assert.match(calendar, /neoadjuvant_treatment: booking\.neoadjuvantTreatment === null \? "" : String\(booking\.neoadjuvantTreatment\)/);
  assert.match(calendar, /neoadjuvant_treatment: moved\.neoadjuvantTreatment === null \? "" : String\(moved\.neoadjuvantTreatment\)/);
  assert.match(calendar, /Neoadjuvant treatment: \$\{neoadjuvantLabel\(booking\.neoadjuvantTreatment\)\}/);
  assert.match(legacy, /neoadjuvantTreatment: null/);
  assert.match(exportRoute, /ได้รับ neoadjuvant treatment มาก่อน/);
  assert.match(exportRoute, /booking\.neoadjuvantTreatment === true \? "ได้รับ"/);
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

test("supports one or many Staff members and filters rooms when any selected Staff already has a case", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const route = await read("app/api/schedule/route.ts");
  assert.match(app, /staffQueuePreference: "any" as "same_staff" \| "any"/);
  assert.match(app, /staffMembers: \[\] as string\[\]/);
  assert.match(app, /type="checkbox"/);
  assert.match(app, /toggleStaffMember/);
  assert.match(app, /ห้องที่ Staff มีเคสแล้ว/);
  assert.match(app, /ห้องไหนก็ได้ที่ยังว่าง/);
  assert.match(app, /booking\.staffMembers\.some\(\(member\) => form\.staffMembers\.includes\(member\)\)/);
  assert.match(app, /staffDayKeys\.has\(`\$\{day\.date\}:\$\{day\.queueType\}`\)/);
  assert.match(route, /staffQueuePreference === "any" \|\| staffDayKeys\.has/);
  assert.match(route, /booking\.staffMembers\.some\(\(member\) => staffMemberSet\.has\(member\)\)/);
  assert.match(route, /submittedStaffMembers\.length === 0/);
  assert.match(route, /new Set\(submittedStaffMembers\)\.size !== submittedStaffMembers\.length/);
});

test("shows a conflict popup and suggests valid alternative OR dates", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const route = await read("app/api/schedule/route.ts");
  assert.match(app, /role="dialog" aria-modal="true"/);
  assert.match(app, /กรุณาเลือกคิวใหม่/);
  assert.match(app, /คิวที่ว่างและตรงเกณฑ์/);
  assert.match(app, /chooseSuggestedQueue/);
  assert.match(app, /response\.status === 409/);
  assert.match(route, /endOfRollingHorizon/);
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

test("stores full-day schedule closures in Calendar and blocks every queue path", async () => {
  const calendar = await read("app/lib/calendar.ts");
  const queue = await read("app/lib/queue.ts");
  const closureRoute = await read("app/api/schedule-closures/route.ts");
  const scheduleRoute = await read("app/api/schedule/route.ts");
  const moveRoute = await read("app/api/cases/[id]/move/route.ts");
  const extraRoute = await read("app/api/extra-days/route.ts");
  assert.match(calendar, /or_queue: "schedule_closure"/);
  assert.match(calendar, /saveScheduleClosureEvent/);
  assert.match(calendar, /deleteScheduleClosureEvent/);
  assert.match(queue, /if \(day\.closed\)/);
  assert.match(queue, /วันที่เลือกปิดรับคิว/);
  assert.match(scheduleRoute, /verifiedDay\.closed/);
  assert.match(moveRoute, /verifiedDay\.closed/);
  assert.match(extraRoute, /วันนี้ปิดรับคิว/);
  assert.match(closureRoute, /confirmExistingBookings/);
  assert.match(closureRoute, /requiresConfirmation: true/);
  assert.match(closureRoute, /affectedBookings/);
});

test("exposes closure management and a rolling 12-month Buddhist calendar", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const schedule = await read("app/lib/schedule.ts");
  const styles = await read("app/globals.css");
  assert.match(schedule, /endOfRollingHorizon/);
  assert.match(schedule, /Date\.UTC\(year, month \+ 12, 0\)/);
  assert.match(app, /scheduleView.*"closures"/);
  assert.match(app, /ตั้งค่าวันปิดรับคิว/);
  assert.match(app, /ค้นหาวันปิดรับคิว/);
  assert.match(app, /ปิดทั้ง OR 17 และ OR Extra/);
  assert.match(app, /disabled=\{Boolean\(closure\) \|\| outsideHorizon\}/);
  assert.match(app, /month >= lastMonth/);
  assert.match(app, /closures=\{data\?\.closures \|\| \[\]\}/);
  assert.match(styles, /\.month-day\.closed/);
  assert.match(styles, /\.closure-manager/);
});

test("smart-searches the selected Staff team without patient identifiers", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const route = await read("app/api/staff-schedule/route.ts");
  const calendar = await read("app/lib/calendar.ts");
  const styles = await read("app/globals.css");
  assert.match(app, /params\.append\("staff", staff\)/);
  assert.match(app, /SMART SEARCH/);
  assert.match(app, /คิวผ่าตัดของ \{staffLabel\(form\.staffMembers\)\}/);
  assert.match(app, /className="field full staff-queue-tools"/);
  assert.match(app, /booking\.diagnosis/);
  assert.match(app, /booking\.operation/);
  assert.match(app, /ไม่แสดงชื่อ สกุล หรือ HN/);
  assert.match(route, /getAll\("staff"\)/);
  assert.match(route, /booking\.staffMembers\.some\(\(member\) => staffMemberSet\.has\(member\)\)/);
  assert.match(route, /staffMembers: booking\.staffMembers/);
  assert.match(route, /diagnosis: booking\.diagnosis/);
  assert.match(route, /operation: booking\.operation/);
  assert.doesNotMatch(route, /hn: booking\.hn/);
  assert.doesNotMatch(route, /patientName/);
  assert.match(calendar, /listUpcomingCalendarBookings/);
  assert.match(calendar, /listAllEvents\(request, from\)/);
  assert.match(styles, /\.staff-queue-tools \{ width: 100%;/);
  assert.match(styles, /\.staff-smart-heading strong[^}]*font-size: 14px/);
  assert.match(styles, /\.staff-smart-heading strong[^}]*overflow-wrap: anywhere/);
  assert.match(styles, /\.staff-smart-list dd[^}]*font-size: 12px/);
});

test("keeps the active-device status static and supports desktop, tablet, and mobile layouts", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const styles = await read("app/globals.css");
  const layout = await read("app/layout.tsx");
  const staffStyles = await read("app/staff-selector-v2.css");
  assert.match(app, /className="presence-status"/);
  assert.match(app, /ขณะนี้มีเครื่องที่ log in เข้าระบบอยู่/);
  assert.doesNotMatch(app, /presence-marquee-track/);
  assert.doesNotMatch(styles, /presence-scroll/);
  assert.doesNotMatch(styles, /presence-marquee-track/);
  assert.match(styles, /@media \(max-width: 1000px\)/);
  assert.match(styles, /@media \(max-width: 820px\)/);
  assert.match(styles, /@media \(max-width: 650px\)/);
  assert.match(styles, /@media \(max-width: 480px\)/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) auto auto/);
  assert.match(layout, /import "\.\/staff-selector-v2\.css"/);
  assert.match(staffStyles, /grid-template-columns: 18px minmax\(0, 1fr\)/);
  assert.match(staffStyles, /input\[type="checkbox"\]/);
  assert.match(staffStyles, /width: 16px !important/);
  assert.match(staffStyles, /@media \(max-width: 650px\)/);
});
