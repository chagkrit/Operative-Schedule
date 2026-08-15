import { listUpcomingCalendarBookings } from "../../lib/calendar";
import { dateOnly, STAFF_OPTIONS } from "../../lib/schedule";

export async function GET(request: Request) {
  try {
    const staff = new URL(request.url).searchParams.get("staff")?.trim() || "";
    if (!STAFF_OPTIONS.includes(staff as (typeof STAFF_OPTIONS)[number])) {
      return Response.json({ error: "กรุณาเลือก Staff จากรายชื่อ" }, { status: 400 });
    }

    const bookings = await listUpcomingCalendarBookings(request, dateOnly());
    return Response.json({
      staff,
      cases: bookings
        .filter((booking) => booking.staff === staff)
        .map((booking) => ({
          id: booking.id,
          scheduleDate: booking.scheduleDate,
          queueType: booking.queueType,
          slotNo: booking.slotNo,
          diagnosis: booking.diagnosis,
          operation: booking.operation,
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
