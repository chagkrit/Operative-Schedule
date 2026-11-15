// The header's calendar status chip text (pure; used by SchedulerApp). Shows the main calendar's account
// from the schedule API (calendarOwnerEmail); falls back to the old static account when it is absent.
export function calendarPillLabel(
  data: { calendarConnected?: boolean; calendarOwnerEmail?: string } | null | undefined,
  calendarError: string | null | undefined,
  fallbackEmail: string,
): string {
  if (data?.calendarConnected) return `Calendar พร้อม · ${data.calendarOwnerEmail || fallbackEmail}`;
  return calendarError ? "Calendar ยังไม่เชื่อม" : "กำลังเชื่อม Google Calendar";
}
