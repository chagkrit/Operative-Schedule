// Admin-only master-calendar API. All rules, validation and status mapping live in
// app/lib/admin-calendar-api.ts (tested with in-memory fakes); this file only binds the real deps.
import { handleAdminCalendar, verifyGoogleAccount, type AdminCalendarDeps } from "../../../lib/admin-calendar-api";
import { AUTHORIZED_EMAIL } from "../../../../auth";
import { calendarSettingsStore } from "../../../lib/calendar-settings-store";
import { userStore } from "../../../lib/user-store";

function deps(): AdminCalendarDeps {
  return {
    users: userStore,
    settings: calendarSettingsStore,
    env: {
      AUTHORIZED_EMAIL,
      GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID,
      CALENDAR_SETTINGS_KEY: process.env.CALENDAR_SETTINGS_KEY,
    },
    verifyAccount: (a) => verifyGoogleAccount(a),
    now: Date.now,
  };
}

export async function GET(request: Request) {
  return handleAdminCalendar(request, "GET", deps());
}

export async function POST(request: Request) {
  return handleAdminCalendar(request, "POST", deps());
}

export const dynamic = "force-dynamic";
