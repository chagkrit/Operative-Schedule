import { listCalendarData, type CalendarBooking, type QueueType } from "./calendar";
import { addDays, isNormalDay } from "./schedule";

export type DaySummary = {
  date: string;
  queueType: QueueType;
  capacity: number;
  note: string;
  count: number;
  cancerCount: number;
  closed: boolean;
  closureName: string;
  closureNote: string;
};

export async function getSchedule(request: Request, from: string, to: string) {
  const { bookings, extras, closures } = await listCalendarData(request, from, to);
  const closuresByDate = new Map(closures.map((closure) => [closure.date, closure]));
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
        closed: closuresByDate.has(date),
        closureName: closuresByDate.get(date)?.name || "",
        closureNote: closuresByDate.get(date)?.note || "",
      });
    }
  }
  for (const extra of extras) {
    summaries.set(`${extra.date}:EXTRA`, {
      date: extra.date,
      queueType: "EXTRA",
      capacity: 4,
      note: extra.note || "คิว OR Extra",
      count: 0,
      cancerCount: 0,
      closed: closuresByDate.has(extra.date),
      closureName: closuresByDate.get(extra.date)?.name || "",
      closureNote: closuresByDate.get(extra.date)?.note || "",
    });
  }
  const legacyExtraCounts = new Map<string, number>();
  for (const booking of bookings) {
    if (booking.queueType === "EXTRA" && !summaries.has(`${booking.scheduleDate}:EXTRA`)) {
      legacyExtraCounts.set(booking.scheduleDate, (legacyExtraCounts.get(booking.scheduleDate) || 0) + 1);
    }
  }
  for (const date of legacyExtraCounts.keys()) {
    summaries.set(`${date}:EXTRA`, {
      date,
      queueType: "EXTRA",
      capacity: 4,
      note: "นำเข้าจาก Google Calendar",
      count: 0,
      cancerCount: 0,
      closed: closuresByDate.has(date),
      closureName: closuresByDate.get(date)?.name || "",
      closureNote: closuresByDate.get(date)?.note || "",
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
    closures,
  };
}

export function destinationError(booking: Pick<CalendarBooking, "isCancer">, day?: DaySummary) {
  if (!day) return "วันที่หรือประเภทคิวที่เลือกไม่ได้เปิดรับคิว";
  if (day.closed) return `วันที่เลือกปิดรับคิว${day.closureName ? `: ${day.closureName}` : ""}`;
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
