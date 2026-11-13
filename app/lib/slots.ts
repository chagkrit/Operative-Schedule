// A case moved into a room-day joins the back of that room's queue (owner, 2026-11-13: "ต่อคิวใหม่ตามห้องนั้นๆ"):
// the number after the last case already there. Only when that would pass the room's capacity does it take the
// lowest free number instead. New bookings keep nextAvailableSlot (lowest free number).
export function appendSlot(
  bookings: readonly { scheduleDate: string; queueType: string; slotNo: number }[],
  date: string,
  queueType: string,
  capacity: number,
): number {
  const used = new Set(
    bookings
      .filter((booking) => booking.scheduleDate === date && booking.queueType === queueType)
      .map((booking) => booking.slotNo),
  );
  const next = Math.max(0, ...used) + 1;
  if (next <= capacity) return next;
  for (let slot = 1; slot <= capacity; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  return capacity + 1;
}
