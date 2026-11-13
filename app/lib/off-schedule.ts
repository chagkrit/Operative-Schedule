// An OR 17 booking whose Calendar event was moved (e.g. dragged in Google Calendar) to a day that
// has no OR 17 room-day would otherwise be invisible in the queue list and missing from every
// capacity count. These room-days are shown flagged and full, so nobody books more cases there.
export const OFF_SCHEDULE_NOTE = "ย้ายใน Google Calendar • นอกวันปกติ";

export function offScheduleRoomDays(
  bookings: readonly { scheduleDate: string; queueType: string }[],
  existingKeys: ReadonlySet<string>,
): { date: string; queueType: "OR17" }[] {
  const dates = new Set<string>();
  for (const booking of bookings) {
    if (booking.queueType === "OR17" && !existingKeys.has(`${booking.scheduleDate}:OR17`)) dates.add(booking.scheduleDate);
  }
  return [...dates].sort().map((date) => ({ date, queueType: "OR17" as const }));
}
