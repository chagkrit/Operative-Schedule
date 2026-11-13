import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "./ts-resolve.mjs";

const { appendSlot } = await import("../app/lib/slots.ts");
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("a case moved into a room-day joins the back of that room's queue", () => {
  // Screenshot case: Monday OR Extra already holds two Calendar-imported cases at #1 and #2.
  const bookings = [
    { scheduleDate: "2026-11-16", queueType: "EXTRA", slotNo: 1 },
    { scheduleDate: "2026-11-16", queueType: "EXTRA", slotNo: 2 },
    { scheduleDate: "2026-11-16", queueType: "OR17", slotNo: 3 }, // the case being moved (other room)
  ];
  assert.equal(appendSlot(bookings, "2026-11-16", "EXTRA", 4), 3);
});

test("appending skips a gap and goes after the last case", () => {
  const bookings = [
    { scheduleDate: "2026-11-17", queueType: "OR17", slotNo: 1 },
    { scheduleDate: "2026-11-17", queueType: "OR17", slotNo: 3 },
  ];
  assert.equal(appendSlot(bookings, "2026-11-17", "OR17", 4), 4);
});

test("an empty room-day starts at #1", () => {
  assert.equal(appendSlot([], "2026-11-19", "EXTRA", 4), 1);
});

test("when the back is past capacity, the lowest free number is used", () => {
  const bookings = [
    { scheduleDate: "2026-11-17", queueType: "OR17", slotNo: 1 },
    { scheduleDate: "2026-11-17", queueType: "OR17", slotNo: 4 },
  ];
  assert.equal(appendSlot(bookings, "2026-11-17", "OR17", 4), 2);
});

test("other days and the other room do not count", () => {
  const bookings = [
    { scheduleDate: "2026-11-17", queueType: "EXTRA", slotNo: 4 },
    { scheduleDate: "2026-11-19", queueType: "OR17", slotNo: 4 },
  ];
  assert.equal(appendSlot(bookings, "2026-11-17", "OR17", 4), 1);
});

test("the move route numbers the moved case with appendSlot; new bookings keep nextAvailableSlot", async () => {
  const move = await read("app/api/cases/[id]/move/route.ts");
  assert.match(move, /slotNo: appendSlot\(bookings, date, queueType!, destination!\.capacity\)/);
  const schedule = await read("app/api/schedule/route.ts");
  assert.match(schedule, /nextAvailableSlot\(bookings, selected\.date/);
});
