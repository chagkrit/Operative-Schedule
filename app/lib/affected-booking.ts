import type { CalendarBooking } from "./calendar";
import { patientDisplayName } from "./privacy";

export function affectedBookingView(booking: CalendarBooking) {
  return {
    id: booking.id,
    hn: booking.hn,
    patientName: patientDisplayName(booking.firstName, booking.lastName),
    operation: booking.operation,
    staffMembers: booking.staffMembers,
    queueType: booking.queueType,
    slotNo: booking.slotNo,
  };
}
