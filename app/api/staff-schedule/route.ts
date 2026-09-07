import { listUpcomingCalendarBookings } from "../../lib/calendar";
import { dateOnly, isStaffOption, orderedStaffMembers } from "../../lib/schedule";

export async function GET(request: Request) {
  try {
    const requestedStaffMembers = new URL(request.url).searchParams.getAll("staff").map((staff) => staff.trim());
    if (!requestedStaffMembers.length || requestedStaffMembers.some((staff) => !isStaffOption(staff))) {
      return Response.json({ error: "กรุณาเลือก Staff จากรายชื่อ" }, { status: 400 });
    }
    if (new Set(requestedStaffMembers).size !== requestedStaffMembers.length) {
      return Response.json({ error: "กรุณาเลือก Staff แต่ละคนเพียงครั้งเดียว" }, { status: 400 });
    }
    const staffMembers = orderedStaffMembers(requestedStaffMembers);
    const staffMemberSet = new Set<string>(staffMembers);

    const bookings = await listUpcomingCalendarBookings(request, dateOnly());
    return Response.json({
      staffMembers,
      cases: bookings
        .filter((booking) => booking.staffMembers.some((member) => staffMemberSet.has(member)))
        .map((booking) => ({
          id: booking.id,
          scheduleDate: booking.scheduleDate,
          queueType: booking.queueType,
          slotNo: booking.slotNo,
          diagnosis: booking.diagnosis,
          operation: booking.operation,
          staffMembers: booking.staffMembers,
        })),
    });
  } catch (error) {
    const status = (error as { status?: number }).status || 500;
    return Response.json(
      { error: error instanceof Error ? error.message : "โหลดคิวของ Staff ไม่สำเร็จ" },
      { status },
    );
  }
}

export const dynamic = "force-dynamic";
