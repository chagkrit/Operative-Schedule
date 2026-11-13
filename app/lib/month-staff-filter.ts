// Pure rules for the monthly calendar's staff filter. No imports: used by the client.
// An empty `staff` string means "all staff" (no filter).

type CaseLike = { scheduleDate: string; staffMembers: readonly string[] };
type UnavailableLike = { staff: string; startDate: string; endDate: string };

export function bookingsForStaff<T extends CaseLike>(bookings: readonly T[], staff: string): T[] {
  return staff ? bookings.filter((booking) => booking.staffMembers.includes(staff)) : [...bookings];
}

// Number of cases per ISO date. Only counts the given staff's cases when `staff` is set.
export function caseCountsByDate(bookings: readonly CaseLike[], staff: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const booking of bookingsForStaff(bookings, staff)) {
    counts.set(booking.scheduleDate, (counts.get(booking.scheduleDate) || 0) + 1);
  }
  return counts;
}

export function isStaffUnavailableOn(entries: readonly UnavailableLike[], staff: string, date: string): boolean {
  return entries.some((entry) => entry.staff === staff && entry.startDate <= date && date <= entry.endDate);
}

// Month summary for one staff member. `month` is "YYYY-MM".
export function staffMonthSummary(
  bookings: readonly CaseLike[],
  entries: readonly UnavailableLike[],
  month: string,
  staff: string,
): { cases: number; unavailableDays: number } {
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  let unavailableDays = 0;
  for (let day = 1; day <= daysInMonth; day += 1) {
    if (isStaffUnavailableOn(entries, staff, `${month}-${String(day).padStart(2, "0")}`)) unavailableDays += 1;
  }
  const cases = bookingsForStaff(bookings, staff).filter((booking) => booking.scheduleDate.startsWith(`${month}-`)).length;
  return { cases, unavailableDays };
}
