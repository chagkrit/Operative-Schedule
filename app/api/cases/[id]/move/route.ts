import {
  getCalendarBooking,
  moveCalendarBooking,
  restoreCalendarBooking,
  type QueueType,
} from "../../../../lib/calendar";
import { destinationError, getSchedule, roomDayDurations, staffBlockedOn } from "../../../../lib/queue";
import { appendSlot } from "../../../../lib/slots";
import { durationInputError, minutesRefusal, minutesRefusalMessage, parseDurationMinutes } from "../../../../lib/minutes";
import { staffUnavailableMessage } from "../../../../lib/staff-unavailability";
import { patientDisplayName } from "../../../../lib/privacy";
import { dateOnly, endOfRollingHorizon, isNormalDay } from "../../../../lib/schedule";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const payload = (await request.json()) as { date?: string; queueType?: QueueType; durationMinutes?: unknown };
    const date = payload.date?.trim() || "";
    const queueType = payload.queueType;
    const today = dateOnly();
    const horizonEnd = endOfRollingHorizon(today);
    if (!date || date < today || date > horizonEnd || !["OR17", "EXTRA"].includes(queueType || "")) {
      return Response.json({ error: "กรุณาเลือกคิวภายในช่วง 12 เดือนข้างหน้า" }, { status: 400 });
    }

    const { booking } = await getCalendarBooking(request, id);
    if (booking.scheduleDate === date && booking.queueType === queueType) {
      return Response.json({ error: "เคสนี้อยู่ในวันและคิวที่เลือกอยู่แล้ว" }, { status: 400 });
    }
    if (!booking.isCancer && (queueType !== "OR17" || !isNormalDay(date))) {
      return Response.json({ error: "เคสที่ไม่ใช่ Cancer ย้ายได้เฉพาะ OR 17 วันอังคารหรือพฤหัสบดี" }, { status: 400 });
    }

    let suppliedDuration: number | null = null;
    if (booking.durationMinutes === null) {
      const durationError = durationInputError(payload.durationMinutes);
      if (durationError) return Response.json({ error: durationError }, { status: 400 });
      suppliedDuration = parseDurationMinutes(payload.durationMinutes);
    }
    const effectiveMinutes = (booking.durationMinutes ?? suppliedDuration) as number;
    const minutesExceededResponse = (refusal: NonNullable<ReturnType<typeof minutesRefusal>>) =>
      Response.json(
        {
          error: minutesRefusalMessage(refusal, queueType === "EXTRA" ? "OR Extra" : "OR 17", date),
          reason: "minutes_exceeded",
          minutes: { booked: refusal.booked, remaining: refusal.remaining, requested: refusal.requested, over: refusal.over, limit: refusal.limit },
          suggestions: [],
        },
        { status: 409 },
      );

    const { days, bookings } = await getSchedule(request, today, horizonEnd);
    const destination = days.find((day) => day.date === date && day.queueType === queueType);
    const invalidDestination = destinationError(booking, destination);
    if (invalidDestination) return Response.json({ error: invalidDestination }, { status: 409 });
    const refusal = minutesRefusal(roomDayDurations(bookings, date, queueType!, id), undefined, effectiveMinutes);
    if (refusal) return minutesExceededResponse(refusal);

    const move = await moveCalendarBooking(request, id, {
      date,
      queueType: queueType!,
      slotNo: appendSlot(bookings, date, queueType!, destination!.capacity),
      ...(suppliedDuration !== null ? { durationMinutes: suppliedDuration } : {}),
    });

    // Re-read the destination after the write. If simultaneous updates overfill it,
    // restore this case to its previous date and ask the user to choose again.
    const verified = await getSchedule(request, date, date);
    const verifiedDay = verified.days.find((day) => day.date === date && day.queueType === queueType);
    if (verifiedDay && staffBlockedOn(booking.staffMembers, verifiedDay)) {
      await restoreCalendarBooking(request, id, move.before);
      return Response.json({ error: staffUnavailableMessage(verifiedDay.unavailableStaff) }, { status: 409 });
    }
    if (!verifiedDay || verifiedDay.closed || verifiedDay.count > verifiedDay.capacity) {
      await restoreCalendarBooking(request, id, move.before);
      return Response.json(
        { error: "มีผู้สลับคิวพร้อมกันและคิวปลายทางเต็ม กรุณาเลือกวันใหม่" },
        { status: 409 },
      );
    }

    const lateRefusal = minutesRefusal(roomDayDurations(verified.bookings, date, queueType!, id), undefined, effectiveMinutes);
    if (lateRefusal) {
      await restoreCalendarBooking(request, id, move.before);
      return minutesExceededResponse(lateRefusal);
    }

    return Response.json({
      message: "สลับวันผ่าตัดและอัปเดต Google Calendar แล้ว",
      move: {
        id,
        hn: move.after.hn,
        patientName: patientDisplayName(move.after.firstName, move.after.lastName),
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
