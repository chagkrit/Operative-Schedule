import { env } from "cloudflare:workers";

type BookingCalendarInput = {
  id: string;
  scheduleDate: string;
  queueType: "OR17" | "EXTRA";
  slotNo: number;
  diagnosis: string;
  isCancer: boolean;
  hn: string;
  firstName: string;
  lastName: string;
  phone: string;
  operation: string;
  staff: string;
  bookedByEmail: string;
};

function runtimeEnv() {
  return env as unknown as Record<string, string | undefined>;
}

export function calendarIsConfigured() {
  const values = runtimeEnv();
  return Boolean(
    values.GOOGLE_CLIENT_ID &&
      values.GOOGLE_CLIENT_SECRET &&
      values.GOOGLE_REFRESH_TOKEN,
  );
}

async function getAccessToken() {
  const values = runtimeEnv();
  if (!calendarIsConfigured()) {
    throw new Error("Google Calendar ยังไม่ได้เชื่อมต่อ");
  }

  const body = new URLSearchParams({
    client_id: values.GOOGLE_CLIENT_ID!,
    client_secret: values.GOOGLE_CLIENT_SECRET!,
    refresh_token: values.GOOGLE_REFRESH_TOKEN!,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json()) as {
    access_token?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || "เชื่อมต่อ Google Calendar ไม่สำเร็จ");
  }
  return payload.access_token;
}

function nextDate(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function maskedHn(hn: string) {
  if (hn.length <= 4) return hn;
  return `••••${hn.slice(-4)}`;
}

export async function createCalendarEvent(booking: BookingCalendarInput) {
  const values = runtimeEnv();
  const calendarId = values.GOOGLE_CALENDAR_ID || "hnbcmu@gmail.com";
  const accessToken = await getAccessToken();
  const room = booking.queueType === "OR17" ? "OR 17" : "OR Extra";
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        summary: `${room} #${booking.slotNo} • ${booking.operation} • HN ${maskedHn(booking.hn)}`,
        description: [
          `Diagnosis: ${booking.diagnosis}`,
          `HN: ${booking.hn}`,
          `ชื่อ-สกุล: ${booking.firstName} ${booking.lastName}`,
          `Tel: ${booking.phone}`,
          `Operation: ${booking.operation}`,
          `Staff: ${booking.staff}`,
          `ประเภทคิว: ${room}`,
          `ลงคิวโดย: ${booking.bookedByEmail}`,
        ].join("\n"),
        location: room,
        start: { date: booking.scheduleDate },
        end: { date: nextDate(booking.scheduleDate) },
        colorId: booking.isCancer ? "11" : "5",
        extendedProperties: {
          private: { booking_id: booking.id, queue_type: booking.queueType },
        },
      }),
    },
  );

  const payload = (await response.json()) as { id?: string; error?: { message?: string } };
  if (!response.ok || !payload.id) {
    throw new Error(payload.error?.message || "สร้างรายการใน Google Calendar ไม่สำเร็จ");
  }
  return payload.id;
}
