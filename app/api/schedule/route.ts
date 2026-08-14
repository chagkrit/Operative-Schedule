import { AUTHORIZED_EMAIL } from "../../../auth";
import { createBookingEvent, deleteBookingEvent, listRecentMoves } from "../../lib/calendar";
import { destinationError, getSchedule, nextAvailableSlot } from "../../lib/queue";
import { addDays, dateOnly, diagnosisIsCancer, isNormalDay, STAFF_OPTIONS } from "../../lib/schedule";

function statusFor(error: unknown) {
  const message = error instanceof Error ? error.message : "เกิดข้อผิดพลาด";
  if (message.includes("เข้าสู่ระบบ") || message.includes("สิทธิ์ Google")) return 401;
  if (message.includes("พร้อมกัน")) return 409;
  return 500;
}

export async function GET(request: Request) {
  try {
    const today = dateOnly();
    const [{ days, bookings }, recentMoves] = await Promise.all([
      getSchedule(request, today, addDays(today, 120)),
      listRecentMoves(request, addDays(today, -730), addDays(today, 120)),
    ]);
    return Response.json({
      days,
      bookings: bookings
        .sort((a, b) => a.scheduleDate.localeCompare(b.scheduleDate) || a.slotNo - b.slotNo)
        .map((booking) => ({
          id: booking.id,
          scheduleDate: booking.scheduleDate,
          queueType: booking.queueType,
          slotNo: booking.slotNo,
          diagnosis: booking.diagnosis,
          isCancer: booking.isCancer,
          hn: booking.hn,
          patientName: `${booking.firstName} ${booking.lastName}`,
          operation: booking.operation,
          staff: booking.staff,
          calendarSyncStatus: "synced" as const,
        })),
      recentMoves: recentMoves.map((booking) => ({
        id: booking.id,
        hn: booking.hn,
        patientName: `${booking.firstName} ${booking.lastName}`,
        operation: booking.operation,
        fromDate: booking.lastMoveFrom,
        toDate: booking.lastMoveTo,
        movedAt: booking.lastMoveAt,
        moveCount: booking.moveCount,
      })),
      importedCount: bookings.filter((booking) => booking.importedFromCalendar).length,
      calendarConnected: true,
      calendarName: AUTHORIZED_EMAIL,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "โหลดข้อมูลไม่สำเร็จ" }, { status: statusFor(error) });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const diagnosis = String(payload.diagnosis || "").trim();
    const hn = String(payload.hn || "").trim();
    const firstName = String(payload.firstName || "").trim();
    const lastName = String(payload.lastName || "").trim();
    const phone = String(payload.phone || "").trim();
    const operation = String(payload.operation || "").trim();
    const staff = String(payload.staff || "").trim();
    const requestedDate = String(payload.requestedDate || "").trim();
    const requestedQueueType = String(payload.requestedQueueType || "").trim();
    const cancerSchedulingMode = String(payload.cancerSchedulingMode || "earliest").trim();
    const missing = [[diagnosis, "Diagnosis"], [hn, "HN"], [firstName, "ชื่อ"], [lastName, "สกุล"], [phone, "Tel"], [operation, "Operation"], [staff, "Staff"]]
      .filter(([value]) => !value).map(([, label]) => label);
    if (missing.length) return Response.json({ error: `กรุณากรอกข้อมูลให้ครบ: ${missing.join(", ")}` }, { status: 400 });
    if (!STAFF_OPTIONS.includes(staff as (typeof STAFF_OPTIONS)[number])) return Response.json({ error: "กรุณาเลือก Staff จากรายชื่อ" }, { status: 400 });

    const isCancer = diagnosisIsCancer(diagnosis);
    const today = dateOnly();
    if (requestedDate && (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) || requestedDate < today)) {
      return Response.json({ error: "กรุณาเลือกวันที่ผ่าตัดตั้งแต่วันนี้เป็นต้นไป" }, { status: 400 });
    }
    if (isCancer && !["earliest", "specific"].includes(cancerSchedulingMode)) return Response.json({ error: "กรุณาเลือกวิธีจัดคิว Cancer" }, { status: 400 });
    if (isCancer && cancerSchedulingMode === "specific" && (!requestedDate || !["OR17", "EXTRA"].includes(requestedQueueType))) {
      return Response.json({ error: "กรุณาเลือกวันที่และประเภทคิวสำหรับ Cancer" }, { status: 400 });
    }
    if (!isCancer && (!requestedDate || !isNormalDay(requestedDate))) {
      return Response.json({ error: "เคสที่ไม่ใช่ Cancer เลือกได้เฉพาะคิวปกติ OR 17 วันอังคารหรือพฤหัสบดี" }, { status: 400 });
    }

    const hasSpecificDate = !isCancer || cancerSchedulingMode === "specific";
    const scheduleFrom = hasSpecificDate ? requestedDate : today;
    const scheduleTo = hasSpecificDate ? requestedDate : addDays(today, 120);
    const { days, bookings } = await getSchedule(request, scheduleFrom, scheduleTo);
    const candidates = isCancer
      ? cancerSchedulingMode === "specific"
        ? days.filter((day) => day.date === requestedDate && day.queueType === requestedQueueType && day.count < day.capacity)
        : days.filter((day) => day.count < day.capacity)
      : days.filter((day) => day.date === requestedDate && day.queueType === "OR17" && day.count < day.capacity);
    if (!candidates.length) {
      return Response.json({ error: isCancer && cancerSchedulingMode === "earliest" ? "ไม่พบคิวว่างใน 120 วันข้างหน้า" : "วันที่หรือประเภทคิวที่เลือกเต็ม หรือไม่ได้เปิดรับคิว" }, { status: 409 });
    }
    const selected = candidates[0];
    const invalidDestination = destinationError({ isCancer }, selected);
    if (invalidDestination) return Response.json({ error: invalidDestination }, { status: 409 });

    const slotNo = nextAvailableSlot(bookings, selected.date, selected.queueType, selected.capacity);
    const id = await createBookingEvent(request, {
      scheduleDate: selected.date,
      queueType: selected.queueType,
      slotNo,
      diagnosis,
      isCancer,
      hn,
      firstName,
      lastName,
      phone,
      operation,
      staff,
      bookedByEmail: AUTHORIZED_EMAIL,
    });
    const verified = await getSchedule(request, selected.date, selected.date);
    const verifiedDay = verified.days.find((day) => day.date === selected.date && day.queueType === selected.queueType);
    if (!verifiedDay || verifiedDay.count > verifiedDay.capacity) {
      await deleteBookingEvent(request, id);
      return Response.json(
        { error: "มีผู้ลงคิวพร้อมกันและคิวเต็ม กรุณาเลือกวันใหม่หรือกดบันทึกอีกครั้ง" },
        { status: 409 },
      );
    }
    return Response.json({ booking: { id, date: selected.date, queueType: selected.queueType, slotNo }, message: "บันทึกและเพิ่มใน Google Calendar แล้ว" }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ" }, { status: statusFor(error) });
  }
}
