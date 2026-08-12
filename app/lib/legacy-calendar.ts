import { diagnosisIsCancer, weekday } from "./schedule";

export type LegacyCalendarEvent = {
  id?: string;
  summary?: string;
  description?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
};

export const LEGACY_STAFF_BY_INITIAL: Record<string, string> = {
  A: "อ อารีวรรณ",
  K: "อ กีรติ",
  P: "อ ปัญจพร",
  C: "อ จักรกริช",
  J: "อ จุฬารัตน์",
  N: "อ ณิชกานต์",
};

export function legacyStaffFromPrefix(value: string) {
  const match = /^\s*(?:อ\.?\s+)?([AKPCJN])(?:[.:-])?(?=\s|[ก-๙(])/i.exec(value);
  if (!match) return { staff: "ไม่ระบุ", prefixLength: 0 };
  return {
    staff: LEGACY_STAFF_BY_INITIAL[match[1].toUpperCase()],
    prefixLength: match[0].length,
  };
}

export function calendarEventDate(event: LegacyCalendarEvent) {
  return event.start?.date || event.start?.dateTime?.slice(0, 10) || "";
}

export function parseLegacyCalendarEvent(event: LegacyCalendarEvent, slotNo = 0) {
  if (!event.id || event.extendedProperties?.private?.or_queue) return null;
  const summary = event.summary?.replace(/\s+/g, " ").trim() || "";
  const source = `${summary} ${event.description || ""}`;
  const scheduleDate = calendarEventDate(event);
  const day = scheduleDate ? weekday(scheduleDate) : -1;
  if (![1, 2, 4].includes(day) || /(or\s*plastic|plastic|ห้องพลาสติก)/i.test(source)) return null;

  const hnMatch = /(^|\D)(\d{6,8})(?!\d)/.exec(summary);
  if (!hnMatch) return null;
  const hnStart = hnMatch.index + hnMatch[1].length;
  const hn = hnMatch[2];
  const hnEnd = hnStart + hn.length;
  const beforeHn = summary.slice(0, hnStart).trim();
  const { staff, prefixLength } = legacyStaffFromPrefix(beforeHn);
  const patientName = beforeHn
    .slice(prefixLength)
    .replace(/^\s*\(\s*C\s*\)\s*/i, "")
    .trim() || "ไม่ระบุชื่อ";
  const operation = summary.slice(hnEnd).replace(/^\s*[-–—:|•]+\s*/, "").trim() || "ไม่ระบุ Operation";
  const queueType = day === 1 || /\b(?:or\s*)?extra\b|เอ็กซ์ตร้า/i.test(source) ? "EXTRA" as const : "OR17" as const;
  const isCancer = queueType === "EXTRA" || diagnosisIsCancer(source) || /\(\s*C\s*\)/i.test(beforeHn);
  const diagnosis = /(^|[^a-z])dcis([^a-z]|$)/i.test(source)
    ? "DCIS"
    : isCancer
      ? "Cancer (นำเข้าจาก Google Calendar)"
      : "ไม่ระบุ (นำเข้าจาก Google Calendar)";

  return {
    id: event.id,
    scheduleDate,
    queueType,
    slotNo,
    diagnosis,
    isCancer,
    hn,
    firstName: patientName,
    lastName: "",
    phone: "",
    operation,
    staff,
    bookedByEmail: "hnbcmu@gmail.com",
    lastMoveFrom: "",
    lastMoveTo: "",
    lastMoveAt: "",
    moveCount: 0,
    importedFromCalendar: true,
  };
}
