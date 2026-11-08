import { AUTHORIZED_EMAIL } from "../../../auth";
import {
  deleteScheduleClosureEvent,
  ifMatchForRestore,
  listCalendarData,
  saveScheduleClosureEvent,
} from "../../lib/calendar";
import { undoCalendarWrite, type UndoOutcome } from "../../lib/calendar-undo";
import { dateOnly, endOfRollingHorizon } from "../../lib/schedule";
import { affectedBookingView } from "../../lib/affected-booking";

function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      id?: string;
      date?: string;
      name?: string;
      note?: string;
      confirmExistingBookings?: boolean;
    };
    const id = payload.id?.trim() || "";
    const date = payload.date?.trim() || "";
    const name = payload.name?.trim() || "";
    const note = payload.note?.trim() || "";
    const today = dateOnly();
    const horizonEnd = endOfRollingHorizon(today);
    if (!validIsoDate(date) || date < today || date > horizonEnd) {
      return Response.json({ error: `กรุณาเลือกวันปิดรับคิวตั้งแต่วันนี้ถึง ${horizonEnd}` }, { status: 400 });
    }
    if (!name) return Response.json({ error: "กรุณาระบุชื่อวันปิดรับคิว" }, { status: 400 });
    if (name.length > 120 || note.length > 500) {
      return Response.json({ error: "ชื่อหรือหมายเหตุยาวเกินกำหนด" }, { status: 400 });
    }

    const current = await listCalendarData(request, today, horizonEnd);
    const duplicate = current.closures.find((closure) => closure.date === date && closure.id !== id);
    if (duplicate) return Response.json({ error: "วันที่นี้ถูกกำหนดเป็นวันปิดรับคิวแล้ว" }, { status: 409 });
    const existing = id ? current.closures.find((closure) => closure.id === id) : undefined;
    if (id && !existing) return Response.json({ error: "ไม่พบวันปิดรับคิวที่ต้องการแก้ไข" }, { status: 404 });

    const affectedBookings = current.bookings
      .filter((booking) => booking.scheduleDate === date)
      .sort((a, b) => a.queueType.localeCompare(b.queueType) || a.slotNo - b.slotNo)
      .map(affectedBookingView);
    if (affectedBookings.length > 0 && !payload.confirmExistingBookings) {
      return Response.json({
        requiresConfirmation: true,
        affectedBookings,
        message: `วันที่เลือกมีคิวเดิม ${affectedBookings.length} เคส คิวเดิมจะยังอยู่และระบบจะปิดรับเฉพาะคิวใหม่`,
      }, { status: 409 });
    }

    const saved = await saveScheduleClosureEvent(request, {
      id: existing?.id,
      date,
      name,
      note,
      updatedBy: AUTHORIZED_EMAIL,
      createdAt: existing?.createdAt,
      createdBy: existing?.createdBy,
    });
    const closureId = saved.id;

    // The duplicate check above and the write are not atomic. New closures share a per-date event id,
    // so two creates for one date land on the same event; the remaining race is a closure moved onto
    // this date (edit) at the same time as another save. Re-read and undo, as for staff unavailability.
    const undoWrite = () => undoCalendarWrite({
      editing: Boolean(existing),
      writtenIds: [closureId],
      restore: async () => saveScheduleClosureEvent(request, {
        id: existing!.id,
        date: existing!.date,
        name: existing!.name,
        note: existing!.note,
        updatedBy: AUTHORIZED_EMAIL,
        createdAt: existing!.createdAt,
        createdBy: existing!.createdBy,
      }, { ifMatch: await ifMatchForRestore(request, existing!.id, saved.etag, { startDate: date, endDate: date }) }),
      remove: (eventId) => deleteScheduleClosureEvent(request, eventId),
    });
    const undoMessage = (lead: string, outcome: UndoOutcome) => {
      if (outcome === "undone") return `${lead} ระบบ${existing ? "คืนค่าการแก้ไขนี้" : "ยกเลิกการบันทึกนี้"}แล้ว กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง`;
      if (outcome === "changed") return `${lead} และรายการนี้ถูกแก้ไขโดยผู้อื่นระหว่างนั้น ระบบจึงไม่คืนค่า กรุณาโหลดข้อมูลใหม่แล้วตรวจสอบ`;
      if (outcome === "uncertain") return `${lead} และระบบไม่แน่ใจว่าคืนค่าสำเร็จหรือไม่ กรุณาโหลดข้อมูลใหม่แล้วตรวจสอบ`;
      return `${lead} และ${existing ? "คืนค่า" : "ยกเลิกการบันทึก"}ไม่สำเร็จ อาจมีวันปิดรับคิวซ้ำในวันเดียวกัน กรุณาโหลดข้อมูลใหม่แล้วตรวจสอบ`;
    };
    let verifiedClosures;
    try {
      verifiedClosures = (await listCalendarData(request, date, date)).closures;
    } catch {
      const outcome = await undoWrite();
      return Response.json({ error: undoMessage("ตรวจสอบวันปิดรับคิวหลังบันทึกไม่สำเร็จ", outcome) }, { status: 503 });
    }
    if (verifiedClosures.some((closure) => closure.date === date && closure.id !== closureId)) {
      const outcome = await undoWrite();
      return Response.json(
        { error: undoMessage("มีผู้บันทึกวันปิดรับคิวในวันที่นี้พร้อมกัน", outcome) },
        { status: outcome === "failed" ? 500 : 409 },
      );
    }
    return Response.json({
      closure: { id: closureId, date, name, note },
      affectedBookings,
      message: affectedBookings.length
        ? `ปิดรับคิวแล้ว โดยคงคิวเดิม ${affectedBookings.length} เคสไว้`
        : "บันทึกวันปิดรับคิวใน Google Calendar แล้ว",
    }, { status: id ? 200 : 201 });
  } catch (error) {
    const status = (error as { status?: number }).status || 500;
    return Response.json({ error: error instanceof Error ? error.message : "บันทึกวันปิดรับคิวไม่สำเร็จ" }, { status });
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id")?.trim() || "";
    if (!id) return Response.json({ error: "ไม่พบวันปิดรับคิว" }, { status: 400 });
    const today = dateOnly();
    const current = await listCalendarData(request, today, endOfRollingHorizon(today));
    const closure = current.closures.find((item) => item.id === id);
    if (!closure) return Response.json({ error: "ไม่พบวันปิดรับคิว" }, { status: 404 });
    await deleteScheduleClosureEvent(request, id);
    return Response.json({ message: "ลบวันปิดรับคิวแล้ว" });
  } catch (error) {
    const status = (error as { status?: number }).status || 500;
    return Response.json({ error: error instanceof Error ? error.message : "ลบวันปิดรับคิวไม่สำเร็จ" }, { status });
  }
}
