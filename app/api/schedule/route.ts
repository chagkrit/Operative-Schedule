import { and, asc, eq, gte, lte } from "drizzle-orm";
import { bookings, extraDays } from "../../../db/schema";
import { getDb } from "../../../db";
import { calendarIsConfigured, createCalendarEvent } from "../../lib/calendar";
import {
  addDays,
  dateOnly,
  diagnosisIsCancer,
  isNormalDay,
  STAFF_OPTIONS,
} from "../../lib/schedule";
import { getSiteUser } from "../../lib/site-user";

type QueueType = "OR17" | "EXTRA";

type DaySummary = {
  date: string;
  queueType: QueueType;
  capacity: number;
  note: string;
  count: number;
  cancerCount: number;
};

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "เกิดข้อผิดพลาด";
  if (message.includes("no such table")) {
    return "ฐานข้อมูลยังไม่พร้อม กรุณารอสักครู่แล้วลองใหม่";
  }
  return message;
}

async function getDays(from: string, to: string) {
  const db = getDb();
  const [savedBookings, savedExtras] = await Promise.all([
    db
      .select()
      .from(bookings)
      .where(and(gte(bookings.scheduleDate, from), lte(bookings.scheduleDate, to)))
      .orderBy(asc(bookings.scheduleDate), asc(bookings.slotNo)),
    db
      .select()
      .from(extraDays)
      .where(and(gte(extraDays.date, from), lte(extraDays.date, to)))
      .orderBy(asc(extraDays.date)),
  ]);

  const summaries = new Map<string, DaySummary>();
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (isNormalDay(date)) {
      summaries.set(`${date}:OR17`, {
        date,
        queueType: "OR17",
        capacity: 4,
        note: "คิวปกติ OR 17",
        count: 0,
        cancerCount: 0,
      });
    }
  }
  for (const extra of savedExtras) {
    summaries.set(`${extra.date}:EXTRA`, {
      date: extra.date,
      queueType: "EXTRA",
      capacity: extra.capacity,
      note: extra.note || "คิว OR Extra",
      count: 0,
      cancerCount: 0,
    });
  }
  for (const booking of savedBookings) {
    const key = `${booking.scheduleDate}:${booking.queueType}`;
    const summary = summaries.get(key);
    if (summary) {
      summary.count += 1;
      if (booking.isCancer) summary.cancerCount += 1;
    }
  }

  return {
    days: [...summaries.values()].sort((a, b) =>
      a.date === b.date
        ? a.queueType === "OR17"
          ? -1
          : 1
        : a.date.localeCompare(b.date),
    ),
    bookings: savedBookings.map((booking) => ({
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
      calendarSyncStatus: booking.calendarSyncStatus,
    })),
  };
}

export async function GET(request: Request) {
  if (!getSiteUser(request)) {
    return Response.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }
  try {
    const today = dateOnly();
    const { days, bookings: rows } = await getDays(today, addDays(today, 55));
    return Response.json({
      days,
      bookings: rows,
      calendarConnected: calendarIsConfigured(),
      calendarName: "hnbcmu@gmail.com",
    });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const user = getSiteUser(request);
  if (!user) {
    return Response.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }
  if (!calendarIsConfigured()) {
    return Response.json(
      { error: "ยังไม่สามารถบันทึกได้: กรุณาเชื่อม Google Calendar ก่อน" },
      { status: 503 },
    );
  }

  let createdBookingId: string | null = null;
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
    const missing = [
      [diagnosis, "Diagnosis"],
      [hn, "HN"],
      [firstName, "ชื่อ"],
      [lastName, "สกุล"],
      [phone, "Tel"],
      [operation, "Operation"],
      [staff, "Staff"],
    ].filter(([value]) => !value).map(([, label]) => label);
    if (missing.length) {
      return Response.json(
        { error: `กรุณากรอกข้อมูลให้ครบ: ${missing.join(", ")}` },
        { status: 400 },
      );
    }
    if (!STAFF_OPTIONS.includes(staff as (typeof STAFF_OPTIONS)[number])) {
      return Response.json({ error: "กรุณาเลือก Staff จากรายชื่อ" }, { status: 400 });
    }

    const isCancer = diagnosisIsCancer(diagnosis);
    if (!isCancer && (!requestedDate || !isNormalDay(requestedDate))) {
      return Response.json(
        { error: "เคสที่ไม่ใช่ Cancer เลือกได้เฉพาะคิวปกติ OR 17 วันอังคารหรือพฤหัสบดี" },
        { status: 400 },
      );
    }

    const today = dateOnly();
    const { days } = await getDays(today, addDays(today, 120));
    const candidates = isCancer
      ? days.filter((day) => day.count < day.capacity)
      : days.filter(
          (day) => day.date === requestedDate && day.queueType === "OR17",
        );
    if (!candidates.length) {
      return Response.json(
        { error: isCancer ? "ไม่พบคิวว่างใน 120 วันข้างหน้า" : "วันที่เลือกเต็มหรือไม่เปิดรับคิว" },
        { status: 409 },
      );
    }

    const selected = candidates[0];
    if (
      !isCancer &&
      selected.queueType === "OR17" &&
      selected.count === 3 &&
      selected.cancerCount === 0
    ) {
      return Response.json(
        { error: "ลงเคสที่ 4 ไม่ได้: วันนี้ยังไม่มีเคส Cancer อย่างน้อย 1 เคส" },
        { status: 409 },
      );
    }
    if (!isCancer && selected.queueType === "EXTRA") {
      return Response.json(
        { error: "OR Extra รับเฉพาะเคสที่ Diagnosis ระบุ Cancer" },
        { status: 400 },
      );
    }

    const db = getDb();
    const id = crypto.randomUUID();
    const slotNo = selected.count + 1;
    createdBookingId = id;
    await db.insert(bookings).values({
      id,
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
      bookedById: user.id,
      bookedByEmail: user.email,
    });

    const eventId = await createCalendarEvent({
      id,
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
      bookedByEmail: user.email,
    });
    await db
      .update(bookings)
      .set({ calendarEventId: eventId, calendarSyncStatus: "synced" })
      .where(eq(bookings.id, id));

    return Response.json(
      {
        booking: { id, date: selected.date, queueType: selected.queueType, slotNo },
        message: "บันทึกและเพิ่มใน Google Calendar แล้ว",
      },
      { status: 201 },
    );
  } catch (error) {
    if (createdBookingId) {
      try {
        await getDb().delete(bookings).where(eq(bookings.id, createdBookingId));
      } catch {
        // Keep the original error as the user-facing result.
      }
    }
    const message = errorMessage(error);
    const isConflict = message.includes("UNIQUE constraint failed");
    return Response.json(
      { error: isConflict ? "มีผู้ลงคิวนี้พร้อมกัน กรุณากดบันทึกอีกครั้ง" : message },
      { status: isConflict ? 409 : 500 },
    );
  }
}
