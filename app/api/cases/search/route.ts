import { searchCalendarBookings } from "../../../lib/calendar";
import { addDays, dateOnly } from "../../../lib/schedule";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams.get("q")?.trim() || "";
    if (query.length < 2) {
      return Response.json({ error: "กรุณาพิมพ์อย่างน้อย 2 ตัวอักษร" }, { status: 400 });
    }
    const today = dateOnly();
    const bookings = await searchCalendarBookings(
      request,
      query,
      addDays(today, -1825),
      addDays(today, 730),
    );
    return Response.json({
      results: bookings.map((booking) => ({
        id: booking.id,
        hn: booking.hn,
        patientName: `${booking.firstName} ${booking.lastName}`,
        diagnosis: booking.diagnosis,
        isCancer: booking.isCancer,
        operation: booking.operation,
        staff: booking.staff,
        scheduleDate: booking.scheduleDate,
        queueType: booking.queueType,
        slotNo: booking.slotNo,
      })),
    });
  } catch (error) {
    const status = (error as { status?: number }).status || 500;
    return Response.json(
      { error: error instanceof Error ? error.message : "ค้นหาไม่สำเร็จ" },
      { status },
    );
  }
}
