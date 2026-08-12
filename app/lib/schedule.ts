export const STAFF_OPTIONS = [
  "อ อารีวรรณ",
  "อ กีรติ",
  "อ ปัญจพร",
  "อ จักรกริช",
  "อ จุฬารัตน์",
  "อ ณิชกานต์",
] as const;

export function dateOnly(date = new Date()) {
  const inBangkok = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return inBangkok.toISOString().slice(0, 10);
}

export function addDays(date: string, amount: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
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
  return /(^|[^a-z])cancer([^a-z]|$)/i.test(diagnosis.trim());
}
