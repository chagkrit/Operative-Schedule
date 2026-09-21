import { deleteBookingEvent, getCalendarBooking } from "../../../lib/calendar";
import { dateOnly } from "../../../lib/schedule";

function statusFor(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("เข้าสู่ระบบ") || message.includes("สิทธิ์ Google")) return 401;
  const status = (error as { status?: number }).status;
  return typeof status === "number" ? status : 500;
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    let payload: { hn?: unknown };
    try {
      payload = (await request.json()) as { hn?: unknown };
    } catch {
      return Response.json({ error: "ข้อมูลยืนยันการลบไม่ถูกต้อง" }, { status: 400 });
    }
    const confirmationHn = String(payload.hn || "").trim();
    if (!confirmationHn) {
      return Response.json({ error: "กรุณากรอก HN เพื่อยืนยันการลบ" }, { status: 400 });
    }

    // Always re-read the event immediately before deleting it. The UI search result
    // may be stale while another device is moving or removing a case.
    const { booking } = await getCalendarBooking(request, id);
    if (booking.scheduleDate < dateOnly()) {
      return Response.json({ error: "ลบได้เฉพาะคิวของวันนี้และอนาคต" }, { status: 400 });
    }
    if (!booking.hn.trim() || booking.hn.trim() !== confirmationHn) {
      return Response.json({ error: "HN ไม่ตรงกับเคสที่เลือก จึงไม่สามารถลบได้" }, { status: 400 });
    }

    await deleteBookingEvent(request, id);
    return Response.json({ message: "ลบเคสออกจาก Google Calendar แล้ว" });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "ลบเคสไม่สำเร็จ" },
      { status: statusFor(error) },
    );
  }
}
