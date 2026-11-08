import assert from "node:assert/strict";
import test from "node:test";
import {
  caseStaffStatus,
  findOverlappingStaff,
  isIsoDate,
  rangesOverlap,
  staffUnavailableMessage,
  unavailableStaffOn,
} from "../app/lib/staff-unavailability.ts";

const r = (startDate, endDate) => ({ startDate, endDate });

test("isIsoDate accepts only real YYYY-MM-DD dates", () => {
  assert.equal(isIsoDate("2027-03-04"), true);
  assert.equal(isIsoDate("2027-02-30"), false);
  assert.equal(isIsoDate("2027-3-4"), false);
  assert.equal(isIsoDate(""), false);
});

test("rangesOverlap is inclusive on both ends", () => {
  assert.equal(rangesOverlap(r("2027-03-03", "2027-03-04"), r("2027-03-05", "2027-03-06")), false);
  assert.equal(rangesOverlap(r("2027-03-04", "2027-03-05"), r("2027-03-05", "2027-03-06")), true);
  assert.equal(rangesOverlap(r("2027-03-01", "2027-03-31"), r("2027-03-10", "2027-03-11")), true);
});

test("findOverlappingStaff finds staff with an overlapping entry", () => {
  const entries = [
    { id: "e1", staff: "อ จักรกริช", startDate: "2027-03-03", endDate: "2027-03-05" },
  ];
  const staff = ["อ จักรกริช", "อ กีรติ"];
  assert.deepEqual(findOverlappingStaff(entries, staff, r("2027-03-05", "2027-03-07")), ["อ จักรกริช"]);
  assert.deepEqual(findOverlappingStaff(entries, staff, r("2027-03-05", "2027-03-07"), "e1"), []);
  assert.deepEqual(findOverlappingStaff(entries, staff, r("2027-03-06", "2027-03-07")), []);
});

test("unavailableStaffOn covers spanning ranges, drops unknown names, follows knownStaff order", () => {
  const entries = [
    { staff: "อ กีรติ", startDate: "2027-03-04", endDate: "2027-03-04" },
    { staff: "อ ชื่อเก่า", startDate: "2027-03-04", endDate: "2027-03-04" },
    { staff: "อ จักรกริช", startDate: "2027-01-01", endDate: "2027-03-10" },
    { staff: "อ จักรกริช", startDate: "2027-03-04", endDate: "2027-03-05" },
  ];
  const known = ["อ จักรกริช", "อ กีรติ"];
  assert.deepEqual(unavailableStaffOn(entries, "2027-03-04", known), ["อ จักรกริช", "อ กีรติ"]);
  assert.deepEqual(unavailableStaffOn(entries, "2027-03-11", known), []);
});

test("caseStaffStatus blocks only when every known case staff is unavailable", () => {
  assert.deepEqual(caseStaffStatus(["A"], ["A"], ["A", "B"]), { blocked: true, unavailableStaff: ["A"] });
  assert.deepEqual(caseStaffStatus(["A", "B"], ["A"], ["A", "B"]), { blocked: false, unavailableStaff: ["A"] });
  assert.deepEqual(caseStaffStatus([], ["A"], ["A"]), { blocked: false, unavailableStaff: [] });
  assert.deepEqual(caseStaffStatus(["ไม่รู้จัก"], ["ไม่รู้จัก"], ["A"]), { blocked: false, unavailableStaff: [] });
});

test("staffUnavailableMessage joins names", () => {
  assert.equal(staffUnavailableMessage(["อ จักรกริช"]), "อ จักรกริช ไม่ว่างในวันที่เลือก");
  assert.equal(staffUnavailableMessage(["A", "B"]), "A, B ไม่ว่างในวันที่เลือก");
});
