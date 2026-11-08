import assert from "node:assert/strict";
import test from "node:test";
import "./ts-resolve.mjs";

const { destinationError, staffBlockedOn } = await import("../app/lib/destination.ts");

const A = "อ จักรกริช";
const B = "อ กีรติ";
const day = (over = {}) => ({
  queueType: "OR17",
  capacity: 4,
  count: 0,
  cancerCount: 0,
  closed: false,
  closureName: "",
  unavailableStaff: [],
  ...over,
});

test("missing or closed day is refused before anything else", () => {
  assert.equal(destinationError({ isCancer: true, staffMembers: [A] }, undefined), "วันที่หรือประเภทคิวที่เลือกไม่ได้เปิดรับคิว");
  assert.equal(
    destinationError({ isCancer: true, staffMembers: [A] }, day({ closed: true, closureName: "สงกรานต์", unavailableStaff: [A], count: 4 })),
    "วันที่เลือกปิดรับคิว: สงกรานต์",
  );
  assert.equal(destinationError({ isCancer: true }, day({ closed: true })), "วันที่เลือกปิดรับคิว");
});

test("every case staff unavailable blocks the day, ahead of capacity", () => {
  assert.equal(
    destinationError({ isCancer: true, staffMembers: [A] }, day({ unavailableStaff: [A], count: 4 })),
    `${A} ไม่ว่างในวันที่เลือก`,
  );
  assert.equal(staffBlockedOn([A], day({ unavailableStaff: [A] })), true);
});

test("one available staff keeps the day open (decision 3)", () => {
  assert.equal(destinationError({ isCancer: true, staffMembers: [A, B] }, day({ unavailableStaff: [A] })), "");
  assert.equal(staffBlockedOn([A, B], day({ unavailableStaff: [A] })), false);
});

test("no known staff on the case is never blocked (call E)", () => {
  assert.equal(destinationError({ isCancer: true }, day({ unavailableStaff: [A] })), "");
  assert.equal(destinationError({ isCancer: true, staffMembers: [] }, day({ unavailableStaff: [A] })), "");
  assert.equal(destinationError({ isCancer: true, staffMembers: ["อ ไม่มีในรายชื่อ"] }, day({ unavailableStaff: [A] })), "");
});

test("capacity and cancer rules still apply", () => {
  assert.equal(destinationError({ isCancer: true, staffMembers: [B] }, day({ count: 4 })), "วันที่เลือกคิวเต็มแล้ว");
  assert.equal(destinationError({ isCancer: false, staffMembers: [B] }, day({ queueType: "EXTRA" })), "OR Extra รับเฉพาะเคส Cancer");
  assert.equal(destinationError({ isCancer: false, staffMembers: [B] }, day({ count: 3 })), "ช่องสุดท้ายของวันนี้รับ Cancer เท่านั้น");
  assert.equal(destinationError({ isCancer: false, staffMembers: [B] }, day({ count: 3, cancerCount: 1 })), "");
  assert.equal(destinationError({ isCancer: true, staffMembers: [B] }, day({ count: 3 })), "");
  assert.equal(destinationError({ isCancer: true, staffMembers: [B] }, day({ queueType: "EXTRA" })), "");
});
