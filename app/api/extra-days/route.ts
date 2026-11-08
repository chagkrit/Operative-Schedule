import { deleteExtraDayEvent, listCalendarData, upsertExtraDayEvent } from "../../lib/calendar";
import { dateOnly, endOfRollingHorizon, isExtraEligibleDay } from "../../lib/schedule";

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" }, { status: 400 });
    }
    const payload = body as Record<string, unknown>;
    if ((payload.date !== undefined && typeof payload.date !== "string") || (payload.note !== undefined && typeof payload.note !== "string")) {
      return Response.json({ error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" }, { status: 400 });
    }
    const date = (payload.date as string | undefined)?.trim() || "";
    const capacity = 4;
    const note = (payload.note as string | undefined)?.trim() || "";
    const today = dateOnly();
    if (!date || date < today || date > endOfRollingHorizon(today)) return Response.json({ error: "กรุณาเลือกวันที่ภายในช่วง 12 เดือนข้างหน้า" }, { status: 400 });
    if (!isExtraEligibleDay(date)) return Response.json({ error: "OR Extra กำหนดได้เฉพาะวันจันทร์หรือพฤหัสบดี" }, { status: 400 });
    const { closures } = await listCalendarData(request, date, date);
    const closure = closures.find((item) => item.date === date);
    if (closure) return Response.json({ error: `วันนี้ปิดรับคิว: ${closure.name}` }, { status: 409 });
    await upsertExtraDayEvent(request, { date, capacity, note });
    return Response.json({ message: "กำหนด OR Extra และเพิ่มใน Google Calendar แล้ว" }, { status: 201 });
  } catch (error) {
    const status = (error as { status?: number }).status || 500;
    return Response.json({ error: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ" }, { status });
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
    const status = (error as { status?: number }).status || 500;
    return Response.json({ error: error instanceof Error ? error.message : "ยกเลิกไม่สำเร็จ" }, { status });
  }
}
