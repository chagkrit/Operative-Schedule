import { listCalendarData, type CalendarBooking, type QueueType } from "./calendar";
import { roomDayMinutes } from "./minutes";
import { addDays, isNormalDay, STAFF_OPTIONS } from "./schedule";
import { unavailableStaffOn } from "./staff-unavailability";

export type DaySummary = {
  date: string;
  queueType: QueueType;
  capacity: number;
  note: string;
  count: number;
  cancerCount: number;
  bookedMinutes: number;
  minutesEnforced: boolean;
  closed: boolean;
  closureName: string;
  closureNote: string;
  unavailableStaff: string[];
};

export async function getSchedule(request: Request, from: string, to: string) {
  const { bookings, extras, closures, staffUnavailability } = await listCalendarData(request, from, to);
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
        bookedMinutes: 0,
        minutesEnforced: false,
        closed: closuresByDate.has(date),
        closureName: closuresByDate.get(date)?.name || "",
        closureNote: closuresByDate.get(date)?.note || "",
        unavailableStaff: unavailableStaffOn(staffUnavailability, date, STAFF_OPTIONS),
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
      bookedMinutes: 0,
      minutesEnforced: false,
      closed: closuresByDate.has(extra.date),
      closureName: closuresByDate.get(extra.date)?.name || "",
      closureNote: closuresByDate.get(extra.date)?.note || "",
      unavailableStaff: unavailableStaffOn(staffUnavailability, extra.date, STAFF_OPTIONS),
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
      bookedMinutes: 0,
      minutesEnforced: false,
      closed: closuresByDate.has(date),
      closureName: closuresByDate.get(date)?.name || "",
      closureNote: closuresByDate.get(date)?.note || "",
      unavailableStaff: unavailableStaffOn(staffUnavailability, date, STAFF_OPTIONS),
    });
  }
  for (const booking of bookings) {
    const summary = summaries.get(`${booking.scheduleDate}:${booking.queueType}`);
    if (summary) {
      summary.count += 1;
      if (booking.isCancer) summary.cancerCount += 1;
    }
  }
  for (const summary of summaries.values()) {
    const { enforced, bookedMinutes } = roomDayMinutes(roomDayDurations(bookings, summary.date, summary.queueType));
    summary.bookedMinutes = bookedMinutes;
    summary.minutesEnforced = enforced;
  }
  return {
    days: [...summaries.values()].sort((a, b) =>
      a.date === b.date ? (a.queueType === "OR17" ? -1 : 1) : a.date.localeCompare(b.date),
    ),
    bookings,
    closures,
    staffUnavailability,
  };
}

export function roomDayDurations(
  bookings: Pick<CalendarBooking, "id" | "scheduleDate" | "queueType" | "durationMinutes">[],
  date: string,
  queueType: QueueType,
  excludeId?: string,
): (number | null)[] {
  return bookings
    .filter((booking) => booking.scheduleDate === date && booking.queueType === queueType && booking.id !== excludeId)
    .map((booking) => booking.durationMinutes);
}

export { destinationError, staffBlockedOn } from "./destination";

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
