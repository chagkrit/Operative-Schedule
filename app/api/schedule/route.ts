import { AUTHORIZED_EMAIL } from "../../../auth";
import { createBookingEvent, listCalendarData, type QueueType } from "../../lib/calendar";
import { addDays, dateOnly, diagnosisIsCancer, isNormalDay, STAFF_OPTIONS } from "../../lib/schedule";

type DaySummary = {
  date: string;
  queueType: QueueType;
  capacity: number;
  note: string;
  count: number;
  cancerCount: number;
};

async function getDays(request: Request, from: string, to: string) {
  const { bookings, extras } = await listCalendarData(request, from, to);
  const summaries = new Map<string, DaySummary>();
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (isNormalDay(date)) {
      summaries.set(`${date}:OR17`, { date, queueType: "OR17", capacity: 4, note: "คิวปกติ OR 17", count: 0, cancerCount: 0 });
    }
  }
  for (const extra of extras) {
    summaries.set(`${extra.date}:EXTRA`, { date: extra.date, queueType: "EXTRA", capacity: extra.capacity, note: extra.note || "คิว OR Extra", count: 0, cancerCount: 0 });
  }
  for (const booking of bookings) {
    const summary = summaries.get(`${booking.scheduleDate}:${booking.queueType}`);
    if (summary) {
      summary.count += 1;
      if (booking.isCancer) summary.cancerCount += 1;
    }
  }
  return {
    days: [...summaries.values()].sort((a, b) => a.date === b.date ? (a.queueType === "OR17" ? -1 : 1) : a.date.localeCompare(b.date)),
    bookings: bookings.sort((a, b) => a.scheduleDate.localeCompare(b.scheduleDate) || a.slotNo - b.slotNo).map((booking) => ({
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
  };
}

function statusFor(error: unknown) {
  const message = error instanceof Error ? error.message : "เกิดข้อผิดพลาด";
  if (message.includes("เข้าสู่ระบบ") || message.includes("สิทธิ์ Google")) return 401;
  if (message.includes("พร้อมกัน")) return 409;
  return 500;
}

export async function GET(request: Request) {
  try {
    const today = dateOnly();
    const { days, bookings } = await getDays(request, today, addDays(today, 120));
    return Response.json({ days, bookings, calendarConnected: true, calendarName: AUTHORIZED_EMAIL });
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
    if (isCancer && !["earliest", "specific"].includes(cancerSchedulingMode)) return Response.json({ error: "กรุณาเลือกวิธีจัดคิว Cancer" }, { status: 400 });
    if (isCancer && cancerSchedulingMode === "specific" && (!requestedDate || !["OR17", "EXTRA"].includes(requestedQueueType))) {
      return Response.json({ error: "กรุณาเลือกวันที่และประเภทคิวสำหรับ Cancer" }, { status: 400 });
    }
    if (!isCancer && (!requestedDate || !isNormalDay(requestedDate))) {
      return Response.json({ error: "เคสที่ไม่ใช่ Cancer เลือกได้เฉพาะคิวปกติ OR 17 วันอังคารหรือพฤหัสบดี" }, { status: 400 });
    }

    const today = dateOnly();
    const { days } = await getDays(request, today, addDays(today, 120));
    const candidates = isCancer
      ? cancerSchedulingMode === "specific"
        ? days.filter((day) => day.date === requestedDate && day.queueType === requestedQueueType && day.count < day.capacity)
        : days.filter((day) => day.count < day.capacity)
      : days.filter((day) => day.date === requestedDate && day.queueType === "OR17" && day.count < day.capacity);
    if (!candidates.length) {
      return Response.json({ error: isCancer && cancerSchedulingMode === "earliest" ? "ไม่พบคิวว่างใน 120 วันข้างหน้า" : "วันที่หรือประเภทคิวที่เลือกเต็ม หรือไม่ได้เปิดรับคิว" }, { status: 409 });
    }
    const selected = candidates[0];
    if (!isCancer && selected.queueType === "OR17" && selected.count === 3 && selected.cancerCount === 0) {
      return Response.json({ error: "ลงเคสที่ 4 ไม่ได้: วันนี้ยังไม่มีเคส Cancer อย่างน้อย 1 เคส" }, { status: 409 });
    }
    if (!isCancer && selected.queueType === "EXTRA") return Response.json({ error: "OR Extra รับเฉพาะเคสที่ Diagnosis ระบุ Cancer" }, { status: 400 });

    const slotNo = selected.count + 1;
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
    return Response.json({ booking: { id, date: selected.date, queueType: selected.queueType, slotNo }, message: "บันทึกและเพิ่มใน Google Calendar แล้ว" }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ" }, { status: statusFor(error) });
  }
}
