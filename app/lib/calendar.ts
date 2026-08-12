import { getToken } from "next-auth/jwt";
import { AUTHORIZED_EMAIL } from "../../auth";
import { addDays } from "./schedule";

export type QueueType = "OR17" | "EXTRA";

export type CalendarBooking = {
  id: string;
  scheduleDate: string;
  queueType: QueueType;
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
  lastMoveFrom: string;
  lastMoveTo: string;
  lastMoveAt: string;
  moveCount: number;
};

export type CalendarExtraDay = {
  id: string;
  date: string;
  capacity: number;
  note: string;
};

type GoogleEvent = {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  updated?: string;
  start?: { date?: string };
  end?: { date?: string };
  extendedProperties?: { private?: Record<string, string> };
};

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || AUTHORIZED_EMAIL;

async function authorizedAccessToken(request: Request) {
  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: new URL(request.url).protocol === "https:",
  });
  if (token?.email?.toLowerCase() !== AUTHORIZED_EMAIL) {
    throw new Error("กรุณาเข้าสู่ระบบด้วย hnbcmu@gmail.com");
  }
  if (token.accessToken && Number(token.expiresAt || 0) * 1000 > Date.now() + 30_000) {
    return String(token.accessToken);
  }
  if (!token.refreshToken || !process.env.AUTH_GOOGLE_ID || !process.env.AUTH_GOOGLE_SECRET) {
    throw new Error("สิทธิ์ Google Calendar หมดอายุ กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID,
      client_secret: process.env.AUTH_GOOGLE_SECRET,
      refresh_token: String(token.refreshToken),
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  const payload = (await response.json()) as { access_token?: string; error_description?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || "ต่ออายุสิทธิ์ Google Calendar ไม่สำเร็จ");
  }
  return payload.access_token;
}

async function googleFetch(request: Request, path: string, init?: RequestInit) {
  const token = await authorizedAccessToken(request);
  const response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    const error = new Error(payload?.error?.message || "เชื่อมต่อ Google Calendar ไม่สำเร็จ");
    Object.assign(error, { status: response.status });
    throw error;
  }
  return response;
}

async function listTaggedEvents(request: Request, tag: "booking" | "extra_day", from: string, to: string) {
  const events: GoogleEvent[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      timeMin: `${from}T00:00:00+07:00`,
      timeMax: `${addDays(to, 1)}T00:00:00+07:00`,
      singleEvents: "true",
      maxResults: "2500",
      privateExtendedProperty: `or_queue=${tag}`,
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await googleFetch(
      request,
      `/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params.toString()}`,
    );
    const payload = (await response.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
    events.push(...(payload.items || []));
    pageToken = payload.nextPageToken || "";
  } while (pageToken);
  return events;
}

function bookingFromEvent(event: GoogleEvent): CalendarBooking | null {
  const data = event.extendedProperties?.private;
  const date = event.start?.date;
  if (!event.id || !data || !date || !["OR17", "EXTRA"].includes(data.queue_type)) return null;
  return {
    id: event.id,
    scheduleDate: date,
    queueType: data.queue_type as QueueType,
    slotNo: Number(data.slot_no || 0),
    diagnosis: data.diagnosis || "",
    isCancer: data.is_cancer === "true",
    hn: data.hn || "",
    firstName: data.first_name || "",
    lastName: data.last_name || "",
    phone: data.phone || "",
    operation: data.operation || "",
    staff: data.staff || "",
    bookedByEmail: data.booked_by || AUTHORIZED_EMAIL,
    lastMoveFrom: data.last_move_from || "",
    lastMoveTo: data.last_move_to || "",
    lastMoveAt: data.last_move_at || "",
    moveCount: Number(data.move_count || 0),
  };
}

export async function listCalendarData(request: Request, from: string, to: string) {
  const [bookingEvents, extraEvents] = await Promise.all([
    listTaggedEvents(request, "booking", from, to),
    listTaggedEvents(request, "extra_day", from, to),
  ]);
  const bookings = bookingEvents.flatMap((event): CalendarBooking[] => {
    const booking = bookingFromEvent(event);
    return booking ? [booking] : [];
  });
  const extras = extraEvents.flatMap((event): CalendarExtraDay[] => {
    const data = event.extendedProperties?.private;
    const date = event.start?.date;
    if (!event.id || !data || !date) return [];
    return [{ id: event.id, date, capacity: Number(data.capacity || 4), note: data.note || "" }];
  });
  return { bookings, extras };
}

async function deterministicId(prefix: string, value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hex.slice(0, 40)}`;
}

function maskedHn(hn: string) {
  return hn.length <= 4 ? hn : `••••${hn.slice(-4)}`;
}

export async function createBookingEvent(
  request: Request,
  booking: Omit<CalendarBooking, "id" | "lastMoveFrom" | "lastMoveTo" | "lastMoveAt" | "moveCount">,
) {
  const id = `oq${crypto.randomUUID().replaceAll("-", "")}`;
  const room = booking.queueType === "OR17" ? "OR 17" : "OR Extra";
  try {
    await googleFetch(request, `/calendars/${encodeURIComponent(CALENDAR_ID)}/events?sendUpdates=none`, {
      method: "POST",
      body: JSON.stringify({
        id,
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
        end: { date: addDays(booking.scheduleDate, 1) },
        colorId: booking.isCancer ? "11" : "5",
        extendedProperties: { private: {
          or_queue: "booking",
          queue_type: booking.queueType,
          slot_no: String(booking.slotNo),
          diagnosis: booking.diagnosis,
          is_cancer: String(booking.isCancer),
          hn: booking.hn,
          first_name: booking.firstName,
          last_name: booking.lastName,
          phone: booking.phone,
          operation: booking.operation,
          staff: booking.staff,
          booked_by: booking.bookedByEmail,
          last_move_from: "",
          last_move_to: "",
          last_move_at: "",
          move_count: "0",
        } },
      }),
    });
  } catch (error) {
    if ((error as { status?: number }).status === 409) {
      throw new Error("มีผู้ลงคิวช่องนี้พร้อมกัน กรุณากดบันทึกอีกครั้ง");
    }
    throw error;
  }
  return id;
}

function normalizedSearch(value: string) {
  return value.toLocaleLowerCase("th-TH").replace(/\s+/g, " ").trim();
}

export async function searchCalendarBookings(
  request: Request,
  query: string,
  from: string,
  to: string,
) {
  const params = new URLSearchParams({
    timeMin: `${from}T00:00:00+07:00`,
    timeMax: `${addDays(to, 1)}T00:00:00+07:00`,
    singleEvents: "true",
    maxResults: "100",
    q: query,
    privateExtendedProperty: "or_queue=booking",
  });
  const response = await googleFetch(
    request,
    `/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params.toString()}`,
  );
  const payload = (await response.json()) as { items?: GoogleEvent[] };
  const needle = normalizedSearch(query);
  return (payload.items || [])
    .flatMap((event): CalendarBooking[] => {
      const booking = bookingFromEvent(event);
      return booking ? [booking] : [];
    })
    .filter((booking) => normalizedSearch(`${booking.hn} ${booking.firstName} ${booking.lastName}`).includes(needle))
    .sort((a, b) => b.scheduleDate.localeCompare(a.scheduleDate))
    .slice(0, 25);
}

export async function listRecentMoves(request: Request, from: string, to: string) {
  const events = await listTaggedEvents(request, "booking", from, to);
  return events
    .flatMap((event): CalendarBooking[] => {
      const booking = bookingFromEvent(event);
      return booking?.lastMoveAt ? [booking] : [];
    })
    .sort((a, b) => b.lastMoveAt.localeCompare(a.lastMoveAt))
    .slice(0, 10);
}

export async function getCalendarBooking(request: Request, id: string) {
  const response = await googleFetch(
    request,
    `/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(id)}`,
  );
  const event = (await response.json()) as GoogleEvent;
  const booking = bookingFromEvent(event);
  if (!booking || event.extendedProperties?.private?.or_queue !== "booking") {
    const error = new Error("ไม่พบเคสผ่าตัดในระบบ");
    Object.assign(error, { status: 404 });
    throw error;
  }
  return { booking, event };
}

function eventDescription(booking: CalendarBooking) {
  const room = booking.queueType === "OR17" ? "OR 17" : "OR Extra";
  return [
    `Diagnosis: ${booking.diagnosis}`,
    `HN: ${booking.hn}`,
    `ชื่อ-สกุล: ${booking.firstName} ${booking.lastName}`,
    `Tel: ${booking.phone}`,
    `Operation: ${booking.operation}`,
    `Staff: ${booking.staff}`,
    `ประเภทคิว: ${room}`,
    `ลงคิวโดย: ${booking.bookedByEmail}`,
  ].join("\n");
}

export async function moveCalendarBooking(
  request: Request,
  id: string,
  target: { date: string; queueType: QueueType; slotNo: number },
) {
  const { booking, event } = await getCalendarBooking(request, id);
  const movedAt = new Date().toISOString();
  const moved: CalendarBooking = {
    ...booking,
    scheduleDate: target.date,
    queueType: target.queueType,
    slotNo: target.slotNo,
    lastMoveFrom: booking.scheduleDate,
    lastMoveTo: target.date,
    lastMoveAt: movedAt,
    moveCount: booking.moveCount + 1,
  };
  const room = moved.queueType === "OR17" ? "OR 17" : "OR Extra";
  const privateData = {
    ...(event.extendedProperties?.private || {}),
    queue_type: moved.queueType,
    slot_no: String(moved.slotNo),
    last_move_from: booking.scheduleDate,
    last_move_to: moved.scheduleDate,
    last_move_at: movedAt,
    move_count: String(moved.moveCount),
  };
  await googleFetch(
    request,
    `/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(id)}?sendUpdates=none`,
    {
      method: "PATCH",
      body: JSON.stringify({
        summary: `${room} #${moved.slotNo} • ${moved.operation} • HN ${maskedHn(moved.hn)}`,
        description: eventDescription(moved),
        location: room,
        start: { date: moved.scheduleDate },
        end: { date: addDays(moved.scheduleDate, 1) },
        extendedProperties: { private: privateData },
      }),
    },
  );
  return { before: booking, after: moved };
}

export async function restoreCalendarBooking(
  request: Request,
  id: string,
  booking: CalendarBooking,
) {
  const { event } = await getCalendarBooking(request, id);
  const room = booking.queueType === "OR17" ? "OR 17" : "OR Extra";
  await googleFetch(
    request,
    `/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(id)}?sendUpdates=none`,
    {
      method: "PATCH",
      body: JSON.stringify({
        summary: `${room} #${booking.slotNo} • ${booking.operation} • HN ${maskedHn(booking.hn)}`,
        description: eventDescription(booking),
        location: room,
        start: { date: booking.scheduleDate },
        end: { date: addDays(booking.scheduleDate, 1) },
        extendedProperties: { private: {
          ...(event.extendedProperties?.private || {}),
          queue_type: booking.queueType,
          slot_no: String(booking.slotNo),
          last_move_from: booking.lastMoveFrom,
          last_move_to: booking.lastMoveTo,
          last_move_at: booking.lastMoveAt,
          move_count: String(booking.moveCount),
        } },
      }),
    },
  );
}

export async function upsertExtraDayEvent(request: Request, extra: Omit<CalendarExtraDay, "id">) {
  const id = await deterministicId("oe", extra.date);
  const body = JSON.stringify({
    id,
    summary: `เปิดคิว OR Extra • ${extra.capacity} เคส`,
    description: `กำหนดคิว OR Extra\nจำนวน: ${extra.capacity} เคส\nหมายเหตุ: ${extra.note || "-"}`,
    start: { date: extra.date },
    end: { date: addDays(extra.date, 1) },
    colorId: "3",
    transparency: "transparent",
    extendedProperties: { private: {
      or_queue: "extra_day",
      capacity: String(extra.capacity),
      note: extra.note,
    } },
  });
  try {
    await googleFetch(request, `/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${id}`, { method: "PUT", body });
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    await googleFetch(request, `/calendars/${encodeURIComponent(CALENDAR_ID)}/events`, { method: "POST", body });
  }
  return id;
}

export async function deleteExtraDayEvent(request: Request, id: string) {
  await googleFetch(request, `/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function deleteBookingEvent(request: Request, id: string) {
  await googleFetch(
    request,
    `/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(id)}?sendUpdates=none`,
    { method: "DELETE" },
  );
}
