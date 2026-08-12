import {
  getCalendarBooking,
  moveCalendarBooking,
  restoreCalendarBooking,
  type QueueType,
} from "../../../../lib/calendar";
import { destinationError, getSchedule, nextAvailableSlot } from "../../../../lib/queue";
import { addDays, dateOnly, isNormalDay } from "../../../../lib/schedule";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const payload = (await request.json()) as { date?: string; queueType?: QueueType };
    const date = payload.date?.trim() || "";
    const queueType = payload.queueType;
    const today = dateOnly();
    if (!date || date < today || date > addDays(today, 120) || !["OR17", "EXTRA"].includes(queueType || "")) {
      return Response.json({ error: "กรุณาเลือกคิวภายใน 120 วันข้างหน้า" }, { status: 400 });
    }

    const { booking } = await getCalendarBooking(request, id);
    if (booking.scheduleDate === date && booking.queueType === queueType) {
      return Response.json({ error: "เคสนี้อยู่ในวันและคิวที่เลือกอยู่แล้ว" }, { status: 400 });
    }
    if (!booking.isCancer && (queueType !== "OR17" || !isNormalDay(date))) {
      return Response.json({ error: "เคสที่ไม่ใช่ Cancer ย้ายได้เฉพาะ OR 17 วันอังคารหรือพฤหัสบดี" }, { status: 400 });
    }

    const { days, bookings } = await getSchedule(request, today, addDays(today, 120));
    const destination = days.find((day) => day.date === date && day.queueType === queueType);
    const invalidDestination = destinationError(booking, destination);
    if (invalidDestination) return Response.json({ error: invalidDestination }, { status: 409 });

    const move = await moveCalendarBooking(request, id, {
      date,
      queueType: queueType!,
      slotNo: nextAvailableSlot(bookings, date, queueType!, destination!.capacity),
    });

    // Re-read the destination after the write. If simultaneous updates overfill it,
    // restore this case to its previous date and ask the user to choose again.
    const verified = await getSchedule(request, date, date);
    const verifiedDay = verified.days.find((day) => day.date === date && day.queueType === queueType);
    if (!verifiedDay || verifiedDay.count > verifiedDay.capacity) {
      await restoreCalendarBooking(request, id, move.before);
      return Response.json(
        { error: "มีผู้สลับคิวพร้อมกันและคิวปลายทางเต็ม กรุณาเลือกวันใหม่" },
        { status: 409 },
      );
    }

    return Response.json({
      message: "สลับวันผ่าตัดและอัปเดต Google Calendar แล้ว",
      move: {
        id,
        hn: move.after.hn,
        patientName: `${move.after.firstName} ${move.after.lastName}`,
        fromDate: move.before.scheduleDate,
        toDate: move.after.scheduleDate,
        movedAt: move.after.lastMoveAt,
      },
    });
  } catch (error) {
    const status = (error as { status?: number }).status || 500;
    return Response.json(
      { error: error instanceof Error ? error.message : "สลับวันผ่าตัดไม่สำเร็จ" },
      { status },
    );
  }
}
