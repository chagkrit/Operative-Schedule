import { listCalendarData, type CalendarBooking, type QueueType } from "./calendar";
import { addDays, isNormalDay } from "./schedule";

export type DaySummary = {
  date: string;
  queueType: QueueType;
  capacity: number;
  note: string;
  count: number;
  cancerCount: number;
};

export async function getSchedule(request: Request, from: string, to: string) {
  const { bookings, extras } = await listCalendarData(request, from, to);
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
  for (const extra of extras) {
    summaries.set(`${extra.date}:EXTRA`, {
      date: extra.date,
      queueType: "EXTRA",
      capacity: extra.capacity,
      note: extra.note || "คิว OR Extra",
      count: 0,
      cancerCount: 0,
    });
  }
  for (const booking of bookings) {
    const summary = summaries.get(`${booking.scheduleDate}:${booking.queueType}`);
    if (summary) {
      summary.count += 1;
      if (booking.isCancer) summary.cancerCount += 1;
    }
  }
  return {
    days: [...summaries.values()].sort((a, b) =>
      a.date === b.date ? (a.queueType === "OR17" ? -1 : 1) : a.date.localeCompare(b.date),
    ),
    bookings,
  };
}

export function destinationError(booking: Pick<CalendarBooking, "isCancer">, day?: DaySummary) {
  if (!day) return "วันที่หรือประเภทคิวที่เลือกไม่ได้เปิดรับคิว";
  if (day.count >= day.capacity) return "วันที่เลือกคิวเต็มแล้ว";
  if (!booking.isCancer && day.queueType === "EXTRA") return "OR Extra รับเฉพาะเคส Cancer";
  if (!booking.isCancer && day.queueType === "OR17" && day.count === 3 && day.cancerCount === 0) {
    return "ช่องสุดท้ายของวันนี้รับ Cancer เท่านั้น";
  }
  return "";
}

export function nextAvailableSlot(
  bookings: Pick<CalendarBooking, "scheduleDate" | "queueType" | "slotNo">[],
  date: string,
  queueType: QueueType,
  capacity: number,
) {
  const used = new Set(
    bookings
      .filter((booking) => booking.scheduleDate === date && booking.queueType === queueType)
      .map((booking) => booking.slotNo),
  );
  for (let slot = 1; slot <= capacity; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  return capacity + 1;
}
