// Pure per-room-per-day surgery-minutes rule. No Calendar/auth imports: the client may import this too.

export const DAILY_MINUTES_LIMIT = 360;

export type MinutesRefusal = { booked: number; remaining: number; requested: number; over: number; limit: number };

const REQUIRED_MESSAGE = "กรุณากรอกระยะเวลาผ่าตัดเป็นนาที";
const RANGE_MESSAGE = `ระยะเวลาผ่าตัดต้องเป็นจำนวนเต็ม 1–${DAILY_MINUTES_LIMIT} นาที`;

/** "" when valid, else a Thai error message. */
export function durationInputError(value: unknown): string {
  if (value === undefined || value === null) return REQUIRED_MESSAGE;
  const text = typeof value === "number" ? (Number.isInteger(value) && value >= 0 ? String(value) : "x") : typeof value === "string" ? value.trim() : "x";
  if (typeof value === "string" && text === "") return REQUIRED_MESSAGE;
  if (!/^\d+$/.test(text)) return RANGE_MESSAGE;
  const n = Number(text);
  return n >= 1 && n <= DAILY_MINUTES_LIMIT ? "" : RANGE_MESSAGE;
}

export function parseDurationMinutes(value: unknown): number | null {
  if (durationInputError(value) !== "") return null;
  return Number(typeof value === "string" ? value.trim() : value);
}

export function roomDayMinutes(durations: readonly (number | null)[]): { enforced: boolean; bookedMinutes: number } {
  return {
    enforced: durations.every((d) => d !== null),
    bookedMinutes: durations.reduce<number>((sum, d) => sum + (d ?? 0), 0),
  };
}

/**
 * others: durations of the other cases on the target room-day (excluding the changed case).
 * previous: the changed case's duration on this same room-day before the change
 * (undefined = new to the day, null = it had none).
 */
export function minutesRefusal(
  others: readonly (number | null)[],
  previous: number | null | undefined,
  next: number,
): MinutesRefusal | null {
  if (previous === null) return null; // setting a first duration is always allowed
  if (others.some((d) => d === null)) return null; // day not enforced after the change
  const booked = others.reduce<number>((s, d) => s + (d ?? 0), 0);
  const after = booked + next;
  const before = booked + (previous ?? 0);
  if (after <= DAILY_MINUTES_LIMIT || after <= before) return null;
  return {
    booked,
    remaining: Math.max(0, DAILY_MINUTES_LIMIT - booked),
    requested: next,
    over: after - DAILY_MINUTES_LIMIT,
    limit: DAILY_MINUTES_LIMIT,
  };
}

export function minutesRefusalMessage(r: MinutesRefusal, roomLabel: string, dateLabel: string): string {
  return `${roomLabel} ${dateLabel} ลงไว้แล้ว ${r.booked} นาที เหลือ ${r.remaining} นาที เคสนี้ ${r.requested} นาที เกิน ${r.over} นาที (เวลาผ่าตัดรวมต่อห้องต่อวันไม่เกิน ${r.limit} นาที)`;
}
