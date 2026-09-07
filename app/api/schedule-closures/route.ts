import { AUTHORIZED_EMAIL } from "../../../auth";
import {
  deleteScheduleClosureEvent,
  listCalendarData,
  saveScheduleClosureEvent,
} from "../../lib/calendar";
import { dateOnly, endOfRollingHorizon } from "../../lib/schedule";

function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function affectedBooking(booking: Awaited<ReturnType<typeof listCalendarData>>["bookings"][number]) {
  return {
    id: booking.id,
    hn: booking.hn,
    patientName: `${booking.firstName} ${booking.lastName}`,
    operation: booking.operation,
    staffMembers: booking.staffMembers,
    queueType: booking.queueType,
    slotNo: booking.slotNo,
  };
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
      .map(affectedBooking);
    if (affectedBookings.length > 0 && !payload.confirmExistingBookings) {
      return Response.json({
        requiresConfirmation: true,
        affectedBookings,
        message: `วันที่เลือกมีคิวเดิม ${affectedBookings.length} เคส คิวเดิมจะยังอยู่และระบบจะปิดรับเฉพาะคิวใหม่`,
      }, { status: 409 });
    }

    const closureId = await saveScheduleClosureEvent(request, {
      id: existing?.id,
      date,
      name,
      note,
      updatedBy: AUTHORIZED_EMAIL,
      createdAt: existing?.createdAt,
      createdBy: existing?.createdBy,
    });
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
