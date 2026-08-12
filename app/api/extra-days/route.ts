import { deleteExtraDayEvent, listCalendarData, upsertExtraDayEvent } from "../../lib/calendar";
import { dateOnly, isExtraEligibleDay } from "../../lib/schedule";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { date?: string; capacity?: number; note?: string };
    const date = payload.date?.trim() || "";
    const capacity = Number(payload.capacity || 4);
    const note = payload.note?.trim() || "";
    if (!date || date < dateOnly()) return Response.json({ error: "กรุณาเลือกวันที่วันนี้เป็นต้นไป" }, { status: 400 });
    if (!isExtraEligibleDay(date)) return Response.json({ error: "OR Extra กำหนดได้เฉพาะวันจันทร์หรือพฤหัสบดี" }, { status: 400 });
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) return Response.json({ error: "จำนวนเคสต้องอยู่ระหว่าง 1–8" }, { status: 400 });
    await upsertExtraDayEvent(request, { date, capacity, note });
    return Response.json({ message: "กำหนด OR Extra และเพิ่มใน Google Calendar แล้ว" }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const date = new URL(request.url).searchParams.get("date") || "";
    if (!date) return Response.json({ error: "ไม่พบวันที่" }, { status: 400 });
    const { bookings, extras } = await listCalendarData(request, date, date);
    if (bookings.some((booking) => booking.scheduleDate === date && booking.queueType === "EXTRA")) {
      return Response.json({ error: "ยกเลิก OR Extra ไม่ได้ เพราะมีเคสลงคิวแล้ว" }, { status: 409 });
    }
    const extra = extras.find((item) => item.date === date);
    if (!extra) return Response.json({ error: "ไม่พบวัน OR Extra" }, { status: 404 });
    await deleteExtraDayEvent(request, extra.id);
    return Response.json({ message: "ยกเลิก OR Extra แล้ว" });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "ยกเลิกไม่สำเร็จ" }, { status: 500 });
  }
}
