import { deleteBookingEvent, getCalendarBooking, restoreCalendarBooking, updateBookingDuration } from "../../../lib/calendar";
import { getSchedule, roomDayDurations } from "../../../lib/queue";
import { durationInputError, minutesRefusal, minutesRefusalMessage, parseDurationMinutes } from "../../../lib/minutes";
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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    let payload: { durationMinutes?: unknown };
    try {
      payload = (await request.json()) as { durationMinutes?: unknown };
    } catch {
      return Response.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    }
    const inputError = durationInputError(payload.durationMinutes);
    if (inputError) return Response.json({ error: inputError }, { status: 400 });
    const next = parseDurationMinutes(payload.durationMinutes) as number;

    const { booking, event } = await getCalendarBooking(request, id);
    if (booking.scheduleDate < dateOnly()) {
      return Response.json({ error: "แก้ได้เฉพาะคิวของวันนี้และอนาคต" }, { status: 400 });
    }
    // Untagged legacy events are parsed from their summary; rewriting them would reset time/summary with slot 0.
    if (booking.importedFromCalendar === true && event.extendedProperties?.private?.or_queue !== "booking") {
      return Response.json({ error: "เคสนี้นำเข้าจาก Google Calendar โดยตรง กรุณาสลับวันเพื่อใส่ระยะเวลา" }, { status: 400 });
    }
    if (booking.durationMinutes === next) {
      return Response.json({ error: "ระยะเวลาเท่าเดิม" }, { status: 400 });
    }

    const roomLabel = booking.queueType === "EXTRA" ? "OR Extra" : "OR 17";
    const refusalResponse = (refusal: NonNullable<ReturnType<typeof minutesRefusal>>) =>
      Response.json(
        {
          error: minutesRefusalMessage(refusal, roomLabel, booking.scheduleDate),
          reason: "minutes_exceeded",
          minutes: { booked: refusal.booked, remaining: refusal.remaining, requested: refusal.requested, over: refusal.over, limit: refusal.limit },
          suggestions: [],
        },
        { status: 409 },
      );

    const { bookings } = await getSchedule(request, booking.scheduleDate, booking.scheduleDate);
    const refusal = minutesRefusal(roomDayDurations(bookings, booking.scheduleDate, booking.queueType, id), booking.durationMinutes, next);
    if (refusal) return refusalResponse(refusal);

    const { before } = await updateBookingDuration(request, id, next);

    const verified = await getSchedule(request, booking.scheduleDate, booking.scheduleDate);
    const lateRefusal = minutesRefusal(roomDayDurations(verified.bookings, booking.scheduleDate, booking.queueType, id), booking.durationMinutes, next);
    if (lateRefusal) {
      await restoreCalendarBooking(request, id, before);
      return refusalResponse(lateRefusal);
    }

    return Response.json({ message: "แก้ระยะเวลาผ่าตัดและอัปเดต Google Calendar แล้ว", durationMinutes: next });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "แก้ระยะเวลาผ่าตัดไม่สำเร็จ" },
      { status: statusFor(error) },
    );
  }
}
