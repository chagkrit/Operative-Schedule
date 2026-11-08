// Rules for whether a case may be booked or moved onto a day. Imports only pure modules
// (no Calendar/auth), so tests can exercise it directly.
import { STAFF_OPTIONS } from "./schedule";
import { caseStaffStatus, staffUnavailableMessage } from "./staff-unavailability";

export type DestinationDay = {
  queueType: "OR17" | "EXTRA";
  capacity: number;
  count: number;
  cancerCount: number;
  closed: boolean;
  closureName: string;
  unavailableStaff: string[];
};

export function staffBlockedOn(
  staffMembers: readonly string[],
  day: Pick<DestinationDay, "unavailableStaff">,
): boolean {
  return caseStaffStatus(staffMembers, day.unavailableStaff, STAFF_OPTIONS).blocked;
}

export function destinationError(
  booking: { isCancer: boolean; staffMembers?: readonly string[] },
  day?: DestinationDay,
) {
  if (!day) return "วันที่หรือประเภทคิวที่เลือกไม่ได้เปิดรับคิว";
  if (day.closed) return `วันที่เลือกปิดรับคิว${day.closureName ? `: ${day.closureName}` : ""}`;
  const staffStatus = caseStaffStatus(booking.staffMembers ?? [], day.unavailableStaff, STAFF_OPTIONS);
  if (staffStatus.blocked) return staffUnavailableMessage(staffStatus.unavailableStaff);
  if (day.count >= day.capacity) return "วันที่เลือกคิวเต็มแล้ว";
  if (!booking.isCancer && day.queueType === "EXTRA") return "OR Extra รับเฉพาะเคส Cancer";
  if (!booking.isCancer && day.queueType === "OR17" && day.count === 3 && day.cancerCount === 0) {
    return "ช่องสุดท้ายของวันนี้รับ Cancer เท่านั้น";
  }
  return "";
}
