export const STAFF_OPTIONS = [
  "อ อารีวรรณ",
  "อ กีรติ",
  "อ ปัญจพร",
  "อ จักรกริช",
  "อ จุฬารัตน์",
  "อ ณิชกานต์",
] as const;

export type StaffOption = (typeof STAFF_OPTIONS)[number];

export function isStaffOption(value: string): value is StaffOption {
  return STAFF_OPTIONS.includes(value as StaffOption);
}

export function orderedStaffMembers(values: readonly string[]) {
  const selected = new Set(values);
  return STAFF_OPTIONS.filter((staff) => selected.has(staff));
}

export function dateOnly(date = new Date()) {
  const inBangkok = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return inBangkok.toISOString().slice(0, 10);
}

export function addDays(date: string, amount: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

export function endOfRollingHorizon(date = dateOnly()) {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month + 12, 0)).toISOString().slice(0, 10);
}

export function weekday(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isNormalDay(date: string) {
  const day = weekday(date);
  return day === 2 || day === 4;
}

export function isExtraEligibleDay(date: string) {
  const day = weekday(date);
  return day === 1 || day === 4;
}

export function diagnosisIsCancer(diagnosis: string) {
  const value = diagnosis.trim();
  return /(^|[^a-z])cancer([^a-z]|$)/i.test(value)
    || /(^|[^a-z])ca\s+(breast|thyroid)([^a-z]|$)/i.test(value)
    || /(^|[^a-z])dcis([^a-z]|$)/i.test(value);
}
