import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { bookingsForStaff, caseCountsByDate, isStaffUnavailableOn, staffMonthSummary } from "../app/lib/month-staff-filter.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const bookings = [
  { id: "1", scheduleDate: "2026-11-26", staffMembers: ["อ กีรติ"] },
  { id: "2", scheduleDate: "2026-11-26", staffMembers: ["อ กีรติ", "อ ปัญจพร"] },
  { id: "3", scheduleDate: "2026-11-26", staffMembers: ["อ ปัญจพร"] },
  { id: "4", scheduleDate: "2026-12-01", staffMembers: ["อ กีรติ"] },
  { id: "5", scheduleDate: "2026-11-27", staffMembers: [] },
];
const entries = [
  { staff: "อ กีรติ", startDate: "2026-11-28", endDate: "2026-12-02" },
  { staff: "อ ปัญจพร", startDate: "2026-11-10", endDate: "2026-11-10" },
];

test("no filter keeps every case and counts the whole day", () => {
  assert.equal(bookingsForStaff(bookings, "").length, 5);
  assert.equal(caseCountsByDate(bookings, "").get("2026-11-26"), 3);
});

test("a staff filter counts only that staff's cases, including co-staffed ones", () => {
  assert.deepEqual(bookingsForStaff(bookings, "อ กีรติ").map((b) => b.id), ["1", "2", "4"]);
  assert.equal(caseCountsByDate(bookings, "อ กีรติ").get("2026-11-26"), 2);
  assert.equal(caseCountsByDate(bookings, "อ กีรติ").get("2026-11-27"), undefined);
});

test("an unknown staff name matches nothing instead of falling back to all", () => {
  assert.equal(bookingsForStaff(bookings, "อ ไม่มี").length, 0);
});

test("unavailable range is inclusive on both ends and per staff", () => {
  assert.equal(isStaffUnavailableOn(entries, "อ กีรติ", "2026-11-28"), true);
  assert.equal(isStaffUnavailableOn(entries, "อ กีรติ", "2026-12-02"), true);
  assert.equal(isStaffUnavailableOn(entries, "อ กีรติ", "2026-11-27"), false);
  assert.equal(isStaffUnavailableOn(entries, "อ กีรติ", "2026-11-10"), false);
});

test("month summary clips a range that crosses the month boundary", () => {
  assert.deepEqual(staffMonthSummary(bookings, entries, "2026-11", "อ กีรติ"), { cases: 2, unavailableDays: 3 });
  assert.deepEqual(staffMonthSummary(bookings, entries, "2026-12", "อ กีรติ"), { cases: 1, unavailableDays: 2 });
});

test("fromDate skips earlier unavailable days (bookings only load from today)", () => {
  assert.deepEqual(staffMonthSummary(bookings, entries, "2026-11", "อ กีรติ", "2026-11-30"), { cases: 2, unavailableDays: 1 });
});

test("clash block uses unfiltered bookings so it never says no clash while another staff has one", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /const selectedClashBookings = bookings\.filter\(\(booking\) => booking\.scheduleDate === selectedDate\)/);
});

test("monthly calendar wires the staff filter and two-line slot time", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /from "\.\/lib\/month-staff-filter"/);
  assert.match(app, /aria-label="กรองตามอาจารย์"/);
  assert.match(app, /className="month-booking-time"/);
});
