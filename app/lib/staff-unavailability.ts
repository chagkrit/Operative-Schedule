// Pure rules for staff unavailable days. No imports: used by server and client.

export type DateRange = { startDate: string; endDate: string };
export type UnavailableEntry = DateRange & { staff: string; id?: string };
export type CaseStaffStatus = { blocked: boolean; unavailableStaff: string[] };

export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

// ISO dates compare correctly as strings. Inclusive on both ends.
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

export function findOverlappingStaff(
  entries: readonly UnavailableEntry[],
  staff: readonly string[],
  range: DateRange,
  ignoreId?: string,
): string[] {
  const hit = new Set(
    entries
      .filter((e) => (ignoreId === undefined || e.id !== ignoreId) && rangesOverlap(e, range))
      .map((e) => e.staff),
  );
  return [...new Set(staff)].filter((s) => hit.has(s));
}

// Entries of the same staff that overlap `range`, other than the entry with `ignoreId`.
export function conflictingEntries(
  entries: readonly UnavailableEntry[],
  staff: string,
  range: DateRange,
  ignoreId?: string,
): UnavailableEntry[] {
  return entries.filter(
    (e) => e.staff === staff && (ignoreId === undefined || e.id !== ignoreId) && rangesOverlap(e, range),
  );
}

// After a concurrent create, both writers see each other. The one with the larger id yields so that
// exactly one survives (both yielding is also safe: nothing overlaps, the user just saves again).
export function yieldsToConcurrentEntry(
  myId: string,
  others: readonly UnavailableEntry[],
): boolean {
  return others.some((e) => e.id !== undefined && e.id < myId);
}

export function unavailableStaffOn(
  entries: readonly UnavailableEntry[],
  date: string,
  knownStaff: readonly string[],
): string[] {
  const hit = new Set(
    entries.filter((e) => e.startDate <= date && date <= e.endDate).map((e) => e.staff),
  );
  return [...new Set(knownStaff)].filter((s) => hit.has(s));
}

export function caseStaffStatus(
  caseStaff: readonly string[],
  unavailableOnDate: readonly string[],
  knownStaff: readonly string[],
): CaseStaffStatus {
  const known = new Set(knownStaff);
  const unavailable = new Set(unavailableOnDate);
  const considered = [...new Set(caseStaff)].filter((s) => known.has(s));
  const unavailableStaff = considered.filter((s) => unavailable.has(s));
  return {
    blocked: considered.length > 0 && unavailableStaff.length === considered.length,
    unavailableStaff,
  };
}

export function staffUnavailableMessage(staff: readonly string[]): string {
  return `${staff.join(", ")} ไม่ว่างในวันที่เลือก`;
}
