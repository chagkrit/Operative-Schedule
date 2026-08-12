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
  assert.match(queue, /day\.count === 3 && day\.cancerCount === 0/);
  assert.match(queue, /ช่องสุดท้ายของวันนี้รับ Cancer เท่านั้น/);
  assert.match(queue, /OR Extra รับเฉพาะเคส Cancer/);
  assert.match(route, /cancerSchedulingMode === "specific"/);
  assert.match(route, /cancerSchedulingMode === "earliest"/);
});

test("searches cases and records verified calendar moves", async () => {
  const calendar = await read("app/lib/calendar.ts");
  const moveRoute = await read("app/api/cases/[id]/move/route.ts");
  const app = await read("app/SchedulerApp.tsx");
  assert.match(calendar, /privateExtendedProperty: "or_queue=booking"/);
  assert.match(calendar, /last_move_from/);
  assert.match(calendar, /last_move_to/);
  assert.match(app, /HN ชื่อ หรือสกุล/);
  assert.match(moveRoute, /destinationError/);
  assert.match(moveRoute, /restoreCalendarBooking/);
  assert.match(moveRoute, /verifiedDay\.count > verifiedDay\.capacity/);
});
