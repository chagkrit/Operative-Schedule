"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { signOutAction } from "./actions";
import { diagnosisIsCancer } from "./lib/schedule";

type Day = {
  date: string;
  queueType: "OR17" | "EXTRA";
  capacity: number;
  note: string;
  count: number;
  cancerCount: number;
  closed: boolean;
  closureName: string;
  closureNote: string;
};

type ScheduleClosure = {
  id: string;
  date: string;
  name: string;
  note: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
};

type Booking = {
  id: string;
  scheduleDate: string;
  queueType: "OR17" | "EXTRA";
  slotNo: number;
  diagnosis: string;
  isCancer: boolean;
  neoadjuvantTreatment: boolean | null;
  hn: string;
  patientName: string;
  operation: string;
  note: string;
  staffMembers: string[];
  calendarSyncStatus: "pending" | "synced" | "failed";
};

type ScheduleResponse = {
  days: Day[];
  bookings: Booking[];
  closures: ScheduleClosure[];
  horizonStart: string;
  horizonEnd: string;
  recentMoves: RecentMove[];
  importedCount: number;
  calendarConnected: boolean;
  calendarName: string;
  error?: string;
};

type RecentMove = {
  id: string;
  hn: string;
  patientName: string;
  operation: string;
  fromDate: string;
  toDate: string;
  movedAt: string;
  moveCount: number;
};

type SearchResult = {
  id: string;
  hn: string;
  patientName: string;
  diagnosis: string;
  isCancer: boolean;
  neoadjuvantTreatment: boolean | null;
  operation: string;
  staffMembers: string[];
  scheduleDate: string;
  queueType: "OR17" | "EXTRA";
  slotNo: number;
};

type QueueSuggestion = {
  date: string;
  queueType: "OR17" | "EXTRA";
  availableSlots: number;
};

type BookingConflict = {
  message: string;
  suggestions: QueueSuggestion[];
};

type StaffUpcomingCase = {
  id: string;
  scheduleDate: string;
  queueType: "OR17" | "EXTRA";
  slotNo: number;
  diagnosis: string;
  operation: string;
  staffMembers: string[];
};

type StaffScheduleState = {
  staffKey: string;
  cases: StaffUpcomingCase[];
  error: string;
};

type AffectedBooking = Pick<Booking, "id" | "hn" | "patientName" | "operation" | "staffMembers" | "queueType" | "slotNo">;

const EMPTY_CLOSURE_FORM = { id: "", date: "", name: "", note: "" };

const STAFF = [
  "อ อารีวรรณ",
  "อ กีรติ",
  "อ ปัญจพร",
  "อ จักรกริช",
  "อ จุฬารัตน์",
  "อ ณิชกานต์",
] as const;

const EMPTY_FORM = {
  diagnosis: "",
  cancerSchedulingMode: "earliest" as "earliest" | "specific",
  dateEntryMode: "list" as "list" | "manual",
  hn: "",
  firstName: "",
  lastName: "",
  phone: "",
  operation: "",
  note: "",
  neoadjuvantTreatment: false,
  staffMembers: [] as string[],
  staffQueuePreference: "any" as "same_staff" | "any",
  requestedDate: "",
  requestedQueueType: "",
};

function staffLabel(staffMembers: readonly string[]) {
  return staffMembers.join(", ") || "ไม่ระบุ";
}

function displayDate(value: string, short = false) {
  return new Intl.DateTimeFormat("th-TH", {
    weekday: short ? "short" : "long",
    day: "numeric",
    month: short ? "short" : "long",
    year: short ? undefined : "numeric",
  }).format(new Date(`${value}T12:00:00+07:00`));
}

function displaySlotTime(slotNo: number) {
  const startHour = 7 + slotNo;
  const hour = (value: number) => String(value).padStart(2, "0");
  return `${hour(startHour)}:00–${hour(startHour + 1)}:00`;
}

function bangkokToday() {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Bangkok",
  }).format(new Date());
}

function daysBetween(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

function addCalendarDays(value: string, amount: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function displayMonth(value: string) {
  return new Intl.DateTimeFormat("th-TH", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  }).format(new Date(`${value}-15T12:00:00+07:00`));
}

function addCalendarMonths(value: string, amount: number) {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + amount, 1)).toISOString().slice(0, 7);
}

type MonthlyCalendarProps = {
  days: Day[];
  bookings: Booking[];
  closures: ScheduleClosure[];
  horizonStart: string;
  horizonEnd: string;
  month: string;
  selectedDate: string;
  onMonthChange: (value: string) => void;
  onSelectDate: (value: string) => void;
};

function MonthlyCalendar({ days, bookings, closures, horizonStart, horizonEnd, month, selectedDate, onMonthChange, onSelectDate }: MonthlyCalendarProps) {
  const firstMonth = horizonStart.slice(0, 7);
  const lastMonth = horizonEnd.slice(0, 7);
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const summariesByDate = new Map<string, Day[]>();
  const closuresByDate = new Map(closures.map((closure) => [closure.date, closure]));
  for (const day of days) {
    summariesByDate.set(day.date, [...(summariesByDate.get(day.date) || []), day]);
  }
  const cells = [
    ...Array.from({ length: firstWeekday }, () => ""),
    ...Array.from({ length: daysInMonth }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`),
  ];
  while (cells.length % 7 !== 0) cells.push("");
  const selectedSummaries = summariesByDate.get(selectedDate) || [];
  const selectedClosure = closuresByDate.get(selectedDate);
  const selectedCount = selectedSummaries.reduce((total, day) => total + day.count, 0);
  const selectedBookings = bookings
    .filter((booking) => booking.scheduleDate === selectedDate)
    .sort((a, b) => a.queueType === b.queueType ? a.slotNo - b.slotNo : a.queueType === "OR17" ? -1 : 1);
  const today = bangkokToday();

  function changeMonth(direction: -1 | 1) {
    const target = addCalendarMonths(month, direction);
    if (target < firstMonth || target > lastMonth) return;
    onMonthChange(target);
    onSelectDate(`${target}-01`);
  }

  return (
    <div className="monthly-calendar">
      <div className="month-toolbar">
        <button type="button" onClick={() => changeMonth(-1)} disabled={month <= firstMonth} aria-label="เดือนก่อนหน้า">‹</button>
        <strong>{displayMonth(month)}</strong>
        <button type="button" onClick={() => changeMonth(1)} disabled={month >= lastMonth} aria-label="เดือนถัดไป">›</button>
      </div>
      <div className="month-grid" role="grid" aria-label={`ปฏิทิน ${displayMonth(month)}`}>
        {['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'].map((label) => <span className="month-weekday" key={label}>{label}</span>)}
        {cells.map((date, index) => {
          if (!date) return <span className="month-blank" key={`blank-${index}`} />;
          const summaries = summariesByDate.get(date) || [];
          const count = summaries.reduce((total, day) => total + day.count, 0);
          const hasExtra = summaries.some((day) => day.queueType === "EXTRA");
          const closure = closuresByDate.get(date);
          const outsideHorizon = date < horizonStart || date > horizonEnd;
          return (
            <button
              type="button"
              className={`month-day ${date === selectedDate ? "selected" : ""} ${date === today ? "today" : ""} ${hasExtra ? "has-extra" : ""} ${closure ? "closed" : ""}`}
              key={date}
              onClick={() => onSelectDate(date)}
              disabled={Boolean(closure) || outsideHorizon}
              title={closure ? `${closure.name}${closure.note ? ` — ${closure.note}` : ""}` : undefined}
              aria-label={closure ? `${displayDate(date)} ปิดรับคิว ${closure.name}` : `${displayDate(date)} ${count} เคส`}
              aria-pressed={date === selectedDate}
            >
              <span>{Number(date.slice(-2))}</span>
              {closure ? <em>ปิด</em> : null}
              {count > 0 ? <b>{count}</b> : summaries.length > 0 ? <i aria-label="เปิดรับคิว" /> : null}
            </button>
          );
        })}
      </div>
      <div className="month-day-summary" aria-live="polite">
        <div>
          <span>{displayDate(selectedDate)}</span>
          <strong>{selectedCount} เคส</strong>
        </div>
        {selectedClosure ? <div className="month-closure-summary"><b>ปิดรับคิว · {selectedClosure.name}</b><span>{selectedClosure.note || "ไม่มีหมายเหตุ"}</span></div>
          : selectedSummaries.length > 0 ? selectedSummaries.map((day) => (
          <p key={`${day.date}:${day.queueType}`}>
            <b>{day.queueType === "EXTRA" ? "OR Extra" : "OR 17"}</b>
            <span>ลงแล้ว {day.count}/{day.capacity} เคส · ว่าง {Math.max(0, day.capacity - day.count)}</span>
          </p>
        )) : <small>วันนี้ไม่มีห้องผ่าตัดที่เปิดรับคิวในระบบ</small>}
      </div>
      <section className="month-bookings" aria-live="polite" aria-label={`เคสผ่าตัดวันที่ ${displayDate(selectedDate)}`}>
        <div className="month-bookings-heading">
          <strong>เคสที่ลงคิวแล้ว</strong>
          <span>{selectedBookings.length} เคส</span>
        </div>
        {selectedBookings.length > 0 ? (
          <div className="month-booking-list">
            {selectedBookings.map((booking) => (
              <article key={booking.id}>
                <div className={`month-booking-slot ${booking.isCancer ? "cancer" : ""}`}>
                  <strong>#{booking.slotNo}</strong>
                  <small>{displaySlotTime(booking.slotNo)}</small>
                </div>
                <div className="month-booking-detail">
                  <strong>{booking.operation}</strong>
                  <span>{booking.patientName} · HN ••••{booking.hn.slice(-4)}</span>
                  <small>{booking.diagnosis} · {staffLabel(booking.staffMembers)} · {booking.queueType === "EXTRA" ? "OR Extra" : "OR 17"}</small>
                </div>
                <StatusDot synced={booking.calendarSyncStatus === "synced"} />
              </article>
            ))}
          </div>
        ) : <p className="month-bookings-empty">ยังไม่มีเคสลงคิวในวันที่เลือก</p>}
      </section>
      <p className="month-legend"><span /> วันที่มี OR Extra <em>ปิด</em> วันปิดรับคิว <b>ตัวเลขในวงกลม = จำนวนเคส</b></p>
    </div>
  );
}

function StatusDot({ synced }: { synced: boolean }) {
  return <span className={`status-dot ${synced ? "synced" : "pending"}`} aria-hidden="true" />;
}

export default function SchedulerApp({ authorizedEmail }: { authorizedEmail: string }) {
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showExtra, setShowExtra] = useState(false);
  const [extra, setExtra] = useState({ date: "", note: "" });
  const [scheduleView, setScheduleView] = useState<"list" | "month" | "closures">("list");
  const [calendarMonth, setCalendarMonth] = useState(() => bangkokToday().slice(0, 7));
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => bangkokToday());
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [selectedCase, setSelectedCase] = useState<SearchResult | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [moving, setMoving] = useState(false);
  const [bookingConflict, setBookingConflict] = useState<BookingConflict | null>(null);
  const [showSyncPrompt, setShowSyncPrompt] = useState(false);
  const [activeDeviceCount, setActiveDeviceCount] = useState(1);
  const [staffSchedule, setStaffSchedule] = useState<StaffScheduleState>({ staffKey: "", cases: [], error: "" });
  const [closureForm, setClosureForm] = useState(EMPTY_CLOSURE_FORM);
  const [closureSearch, setClosureSearch] = useState("");
  const [closureSaving, setClosureSaving] = useState(false);
  const [pendingClosure, setPendingClosure] = useState<{ bookings: AffectedBooking[]; message: string } | null>(null);
  const [exportRange, setExportRange] = useState(() => {
    const today = bangkokToday();
    return { from: addCalendarDays(today, -1825), to: addCalendarDays(today, 730) };
  });
  const [exporting, setExporting] = useState(false);
  const conflictCloseRef = useRef<HTMLButtonElement>(null);
  const syncPromptButtonRef = useRef<HTMLButtonElement>(null);
  const closureConfirmRef = useRef<HTMLButtonElement>(null);

  const loadSchedule = useCallback(async (showSuccess = false) => {
    try {
      const response = await fetch("/api/schedule", { cache: "no-store" });
      const payload = (await response.json()) as ScheduleResponse;
      if (!response.ok) throw new Error(payload.error || "โหลดตารางคิวไม่สำเร็จ");
      setData(payload);
      setCalendarError(null);
      setLastSyncedAt(new Date());
      if (showSuccess) {
        setNotice({ type: "success", text: `Sync Google Calendar แล้ว · นำเข้าข้อมูลเดิม ${payload.importedCount} เคส` });
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "โหลดข้อมูลไม่สำเร็จ";
      setCalendarError(message);
      setNotice({ type: "error", text: message });
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSchedule(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSchedule]);

  useEffect(() => {
    if (!bookingConflict && !showSyncPrompt && !pendingClosure) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setBookingConflict(null);
        setShowSyncPrompt(false);
        setPendingClosure(null);
      }
    };
    document.body.style.overflow = "hidden";
    (bookingConflict ? conflictCloseRef.current : pendingClosure ? closureConfirmRef.current : syncPromptButtonRef.current)?.focus();
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [bookingConflict, pendingClosure, showSyncPrompt]);

  useEffect(() => {
    const storageKey = "or-queue-device-id";
    const deviceId = window.localStorage.getItem(storageKey) || crypto.randomUUID();
    window.localStorage.setItem(storageKey, deviceId);
    let stopped = false;

    async function heartbeat() {
      try {
        const response = await fetch("/api/presence", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId, active: true }),
        });
        const payload = (await response.json()) as { activeDevices?: number };
        if (!stopped && response.ok && payload.activeDevices) setActiveDeviceCount(payload.activeDevices);
      } catch {
        // Keep the last known count when the presence heartbeat is unavailable.
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void heartbeat();
    };
    void heartbeat();
    const timer = window.setInterval(() => void heartbeat(), 30_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      navigator.sendBeacon("/api/presence", new Blob([JSON.stringify({ deviceId, active: false })], { type: "application/json" }));
    };
  }, []);

  const selectedStaffKey = form.staffMembers.join("|");

  useEffect(() => {
    if (!form.staffMembers.length) return;

    const selectedStaffMembers = form.staffMembers;
    const controller = new AbortController();
    const params = new URLSearchParams();
    selectedStaffMembers.forEach((staff) => params.append("staff", staff));
    fetch(`/api/staff-schedule?${params.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json()) as { cases?: StaffUpcomingCase[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "โหลดคิวของ Staff ไม่สำเร็จ");
        setStaffSchedule({ staffKey: selectedStaffMembers.join("|"), cases: payload.cases || [], error: "" });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStaffSchedule({
          staffKey: selectedStaffMembers.join("|"),
          cases: [],
          error: error instanceof Error ? error.message : "โหลดคิวของ Staff ไม่สำเร็จ",
        });
      });

    return () => controller.abort();
  }, [selectedStaffKey, form.staffMembers, lastSyncedAt]);

  const staffScheduleLoading = Boolean(form.staffMembers.length) && staffSchedule.staffKey !== selectedStaffKey;
  const staffUpcomingCases = staffSchedule.staffKey === selectedStaffKey ? staffSchedule.cases : [];
  const staffScheduleError = staffSchedule.staffKey === selectedStaffKey ? staffSchedule.error : "";

  const cancer = diagnosisIsCancer(form.diagnosis);
  const staffDayKeys = useMemo(() => new Set(
    (data?.bookings || [])
      .filter((booking) => booking.staffMembers.some((member) => form.staffMembers.includes(member)))
      .map((booking) => `${booking.scheduleDate}:${booking.queueType}`),
  ), [data, form.staffMembers]);
  const availableDays = useMemo(
    () => (data?.days || []).filter((day) =>
      !day.closed
      && day.count < day.capacity
      && (cancer || day.queueType !== "OR17" || day.count < 3 || day.cancerCount > 0)
      && (form.staffQueuePreference === "any" || staffDayKeys.has(`${day.date}:${day.queueType}`)),
    ),
    [cancer, data, form.staffQueuePreference, staffDayKeys],
  );
  const dropdownCutoff = addCalendarDays(data?.horizonStart || bangkokToday(), 120);
  const dropdownAvailableDays = useMemo(
    () => availableDays.filter((day) => day.date <= dropdownCutoff),
    [availableDays, dropdownCutoff],
  );
  const normalDates = useMemo(
    () => dropdownAvailableDays.filter((day) => day.queueType === "OR17"),
    [dropdownAvailableDays],
  );
  const cancerDates = useMemo(
    () => dropdownAvailableDays,
    [dropdownAvailableDays],
  );
  const upcomingDays = data?.days.slice(0, 8) || [];
  const nextCancerDay = useMemo(
    () => availableDays[0],
    [availableDays],
  );
  const manualDateStart = useMemo(() => {
    const dropdownDays = cancer ? cancerDates : normalDates;
    const lastDropdownDate = dropdownDays.at(-1)?.date || data?.days.at(-1)?.date || bangkokToday();
    return addCalendarDays(lastDropdownDate, 1);
  }, [cancer, cancerDates, data, normalDates]);
  const selectedSurgeryDate = cancer && form.cancerSchedulingMode === "earliest"
    ? nextCancerDay?.date || ""
    : form.requestedDate;
  const selectedQueueType = cancer && form.cancerSchedulingMode === "earliest"
    ? nextCancerDay?.queueType || ""
    : form.requestedQueueType || (!cancer ? "OR17" : "");
  const queuedDate = bangkokToday();
  const waitingDays = selectedSurgeryDate ? daysBetween(queuedDate, selectedSurgeryDate) : null;
  const bookingsByDay = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const booking of data?.bookings || []) {
      const key = `${booking.scheduleDate}:${booking.queueType}`;
      map.set(key, [...(map.get(key) || []), booking]);
    }
    return map;
  }, [data]);
  const moveDates = useMemo(() => {
    if (!selectedCase) return [];
    return (data?.days || []).filter((day) => {
      if (day.closed) return false;
      if (day.count >= day.capacity) return false;
      if (day.date === selectedCase.scheduleDate && day.queueType === selectedCase.queueType) return false;
      if (!selectedCase.isCancer && day.queueType !== "OR17") return false;
      if (!selectedCase.isCancer && day.queueType === "OR17" && day.count === 3 && day.cancerCount === 0) return false;
      return true;
    });
  }, [data, selectedCase]);
  const filteredClosures = useMemo(() => {
    const query = closureSearch.trim().toLocaleLowerCase("th-TH");
    return (data?.closures || []).filter((closure) => !query
      || `${closure.date} ${closure.name} ${closure.note}`.toLocaleLowerCase("th-TH").includes(query));
  }, [closureSearch, data]);

  function updateField(name: keyof typeof EMPTY_FORM, value: string) {
    setForm((current) => ({ ...current, [name]: value } as typeof EMPTY_FORM));
    setNotice(null);
  }

  function toggleStaffMember(staff: string) {
    setForm((current) => ({
      ...current,
      staffMembers: current.staffMembers.includes(staff)
        ? current.staffMembers.filter((member) => member !== staff)
        : STAFF.filter((member) => [...current.staffMembers, staff].includes(member)),
      staffQueuePreference: current.staffMembers.length === 1 && current.staffMembers.includes(staff)
        ? "any"
        : current.staffQueuePreference,
      requestedDate: "",
      requestedQueueType: "OR17",
    }));
    setNotice(null);
  }

  function chooseStaffQueuePreference(value: "same_staff" | "any") {
    setForm((current) => ({
      ...current,
      staffQueuePreference: value,
      requestedDate: "",
      requestedQueueType: "OR17",
    }));
    setNotice(null);
  }

  function chooseCancerDate(value: string) {
    const [requestedDate = "", requestedQueueType = ""] = value.split("|");
    setForm((current) => ({ ...current, requestedDate, requestedQueueType }));
    setNotice(null);
  }

  function setDateEntryMode(mode: "list" | "manual") {
    setForm((current) => ({
      ...current,
      dateEntryMode: mode,
      requestedDate: "",
      requestedQueueType: "OR17",
    }));
    setNotice(null);
  }

  function chooseManualDate(value: string) {
    setForm((current) => ({
      ...current,
      requestedDate: value,
      requestedQueueType: current.requestedQueueType || "OR17",
    }));
    setNotice(null);
  }

  function chooseSuggestedQueue(suggestion: QueueSuggestion) {
    setForm((current) => ({
      ...current,
      cancerSchedulingMode: diagnosisIsCancer(current.diagnosis) ? "specific" : current.cancerSchedulingMode,
      dateEntryMode: "manual",
      requestedDate: suggestion.date,
      requestedQueueType: suggestion.queueType,
    }));
    setBookingConflict(null);
    setNotice({ type: "success", text: "เลือกคิวใหม่แล้ว กรุณาตรวจสอบและกดบันทึกอีกครั้ง" });
  }

  async function syncCalendar() {
    setSyncing(true);
    setNotice(null);
    try {
      return await loadSchedule(true);
    } finally {
      setSyncing(false);
    }
  }

  async function confirmSyncAfterBooking() {
    const synced = await syncCalendar();
    if (synced) setShowSyncPrompt(false);
  }

  async function exportWaitingTime() {
    if (!exportRange.from || !exportRange.to || exportRange.from > exportRange.to) {
      setNotice({ type: "error", text: "กรุณาระบุช่วงวันผ่าตัดสำหรับ Export ให้ถูกต้อง" });
      return;
    }
    setExporting(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/wait-time-export?from=${encodeURIComponent(exportRange.from)}&to=${encodeURIComponent(exportRange.to)}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error || "Export ข้อมูลเวลารอผ่าตัดไม่สำเร็จ");
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `operative-waiting-time_${exportRange.from}_to_${exportRange.to}.xlsx`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setNotice({ type: "success", text: "ดาวน์โหลดไฟล์ Excel ข้อมูลระยะเวลารอผ่าตัดแล้ว" });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Export ข้อมูลเวลารอผ่าตัดไม่สำเร็จ" });
    } finally {
      setExporting(false);
    }
  }

  async function submitBooking(event: FormEvent) {
    event.preventDefault();
    const labels: Record<string, string> = {
      diagnosis: "Diagnosis",
      hn: "HN",
      firstName: "ชื่อ",
      lastName: "สกุล",
      phone: "Tel",
      operation: "Operation",
      staffMembers: "Staff",
    };
    const missing = Object.entries(labels)
      .filter(([key]) => key === "staffMembers"
        ? form.staffMembers.length === 0
        : !String(form[key as keyof typeof form]).trim())
      .map(([, label]) => label);
    if ((!cancer || form.cancerSchedulingMode === "specific") && !form.requestedDate) {
      missing.push("วันที่ผ่าตัด");
    }
    if (missing.length) {
      setNotice({ type: "error", text: `ยังบันทึกไม่ได้ กรุณากรอก: ${missing.join(", ")}` });
      return;
    }
    if (form.dateEntryMode === "manual" && form.requestedDate && form.requestedDate < manualDateStart) {
      setNotice({ type: "error", text: `ระบุวันเองได้ตั้งแต่ ${displayDate(manualDateStart)} เป็นต้นไป` });
      return;
    }
    if (form.requestedDate && data?.horizonEnd && form.requestedDate > data.horizonEnd) {
      setNotice({ type: "error", text: `เลือกวันได้ไม่เกิน ${displayDate(data.horizonEnd)}` });
      return;
    }
    if (!data?.calendarConnected) {
      setNotice({ type: "error", text: "ยังบันทึกไม่ได้ กรุณาเชื่อม Google Calendar ก่อน" });
      return;
    }

    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch("/api/schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
        booking?: { date: string; queueType: string };
        suggestions?: QueueSuggestion[];
      };
      if (!response.ok) {
        const message = payload.error || "บันทึกไม่สำเร็จ";
        if (response.status === 409) {
          setBookingConflict({ message, suggestions: payload.suggestions || [] });
        }
        setNotice({ type: "error", text: message });
        return;
      }
      const room = payload.booking?.queueType === "EXTRA" ? "OR Extra" : "OR 17";
      setNotice({ type: "success", text: `${payload.message} • ${displayDate(payload.booking!.date, true)} • ${room}` });
      setBookingConflict(null);
      setShowSyncPrompt(true);
      setForm(EMPTY_FORM);
      await loadSchedule();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ" });
    } finally {
      setSaving(false);
    }
  }

  async function submitExtra(event: FormEvent) {
    event.preventDefault();
    if (!extra.date) {
      setNotice({ type: "error", text: "กรุณาเลือกวันที่ OR Extra" });
      return;
    }
    try {
      const response = await fetch("/api/extra-days", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(extra),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "กำหนดวันไม่สำเร็จ");
      setNotice({ type: "success", text: payload.message || "กำหนด OR Extra แล้ว" });
      setExtra({ date: "", note: "" });
      setShowExtra(false);
      await loadSchedule();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "กำหนดวันไม่สำเร็จ" });
    }
  }

  async function saveClosure(confirmExistingBookings = false) {
    if (!closureForm.date || !closureForm.name.trim()) {
      setNotice({ type: "error", text: "กรุณาระบุวันที่และชื่อวันปิดรับคิว" });
      return;
    }
    setClosureSaving(true);
    setNotice(null);
    try {
      const response = await fetch("/api/schedule-closures", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...closureForm, confirmExistingBookings }),
      });
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
        requiresConfirmation?: boolean;
        affectedBookings?: AffectedBooking[];
      };
      if (response.status === 409 && payload.requiresConfirmation) {
        setPendingClosure({ bookings: payload.affectedBookings || [], message: payload.message || "วันที่เลือกมีคิวเดิม" });
        return;
      }
      if (!response.ok) throw new Error(payload.error || "บันทึกวันปิดรับคิวไม่สำเร็จ");
      setPendingClosure(null);
      setClosureForm(EMPTY_CLOSURE_FORM);
      setNotice({ type: "success", text: payload.message || "บันทึกวันปิดรับคิวแล้ว" });
      await loadSchedule();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "บันทึกวันปิดรับคิวไม่สำเร็จ" });
    } finally {
      setClosureSaving(false);
    }
  }

  function submitClosure(event: FormEvent) {
    event.preventDefault();
    void saveClosure(false);
  }

  function editClosure(closure: ScheduleClosure) {
    setClosureForm({ id: closure.id, date: closure.date, name: closure.name, note: closure.note });
    setNotice(null);
  }

  async function deleteClosure(closure: ScheduleClosure) {
    if (!window.confirm(`ลบวันปิดรับคิว ${displayDate(closure.date)} — ${closure.name} ใช่หรือไม่`)) return;
    setClosureSaving(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/schedule-closures?id=${encodeURIComponent(closure.id)}`, { method: "DELETE" });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "ลบวันปิดรับคิวไม่สำเร็จ");
      if (closureForm.id === closure.id) setClosureForm(EMPTY_CLOSURE_FORM);
      setNotice({ type: "success", text: payload.message || "ลบวันปิดรับคิวแล้ว" });
      await loadSchedule();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "ลบวันปิดรับคิวไม่สำเร็จ" });
    } finally {
      setClosureSaving(false);
    }
  }

  async function searchCases(event?: FormEvent) {
    event?.preventDefault();
    const query = searchQuery.trim();
    if (query.length < 2) {
      setNotice({ type: "error", text: "กรุณาพิมพ์ HN ชื่อ หรือสกุล อย่างน้อย 2 ตัวอักษร" });
      return;
    }
    setSearching(true);
    setSearched(true);
    setSelectedCase(null);
    setMoveTarget("");
    try {
      const response = await fetch(`/api/cases/search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      const payload = (await response.json()) as { results?: SearchResult[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "ค้นหาไม่สำเร็จ");
      setSearchResults(payload.results || []);
    } catch (error) {
      setSearchResults([]);
      setNotice({ type: "error", text: error instanceof Error ? error.message : "ค้นหาไม่สำเร็จ" });
    } finally {
      setSearching(false);
    }
  }

  async function moveCase(event: FormEvent) {
    event.preventDefault();
    if (!selectedCase || !moveTarget) {
      setNotice({ type: "error", text: "กรุณาเลือกเคสและวันผ่าตัดปลายทาง" });
      return;
    }
    const [date, queueType] = moveTarget.split("|");
    setMoving(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(selectedCase.id)}/move`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date, queueType }),
      });
      const payload = (await response.json()) as { error?: string; message?: string; move?: { fromDate: string; toDate: string } };
      if (!response.ok) throw new Error(payload.error || "สลับวันผ่าตัดไม่สำเร็จ");
      setNotice({
        type: "success",
        text: `${payload.message} • ${displayDate(payload.move!.fromDate, true)} → ${displayDate(payload.move!.toDate, true)}`,
      });
      setSelectedCase(null);
      setMoveTarget("");
      await loadSchedule();
      await searchCases();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "สลับวันผ่าตัดไม่สำเร็จ" });
    } finally {
      setMoving(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Image src="/unit-logo.jpg" alt="Breast & Endocrine Surgery CMU" className="brand-logo" width={58} height={58} priority />
          <div>
            <p className="eyebrow">BREAST &amp; ENDOCRINE SURGERY CMU</p>
            <h1>OR Queue</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <div className={`calendar-pill ${data?.calendarConnected ? "connected" : "disconnected"}`} title={calendarError || undefined}>
            <StatusDot synced={Boolean(data?.calendarConnected)} />
            <span>{data?.calendarConnected ? `Calendar พร้อม · ${authorizedEmail}` : calendarError ? "Calendar ยังไม่เชื่อม" : "กำลังเชื่อม Google Calendar"}</span>
          </div>
          <button className="sync-button" type="button" onClick={syncCalendar} disabled={syncing || loading}>{syncing ? "กำลัง Sync…" : "↻ Sync ทันที"}</button>
          <button className="export-button" type="button" onClick={() => void exportWaitingTime()} disabled={exporting || loading}>{exporting ? "กำลัง Export…" : "Export Excel"}</button>
          <form action={signOutAction}><button className="signout-button" type="submit">ออกจากระบบ</button></form>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow pink">SURGICAL SCHEDULING</p>
          <h2>ลงคิวผ่าตัด<br /><span>ชัดเจน ปลอดภัย ไม่ชนกัน</span></h2>
          <p className="hero-copy">ระบบจัดคิว OR 17 และ OR Extra ตามเกณฑ์ของหน่วย พร้อมส่งรายการเข้าปฏิทินกลางทันทีหลังบันทึก</p>
          <div className="presence-status" role="status" aria-live="polite" title="จำนวนอุปกรณ์ที่ส่งสัญญาณใช้งานภายใน 90 วินาทีล่าสุด">
            <span className="presence-status-dot" aria-hidden="true" />
            <span>ขณะนี้มีเครื่องที่ log in เข้าระบบอยู่ <strong>{activeDeviceCount}</strong> เครื่อง</span>
          </div>
        </div>
        <div className="rule-card">
          <div className="rule-number">4</div>
          <div>
            <strong>เคสสูงสุด / วัน</strong>
            <p>OR 17 ทุกวันอังคารและพฤหัสบดี ต้องมี Cancer อย่างน้อย 1 เคส</p>
          </div>
        </div>
      </section>

      {!loading && (!data?.calendarConnected || calendarError) && (
        <div className="setup-banner" role="status">
          <span className="banner-icon">!</span>
          <div><strong>ยังอ่านข้อมูลจาก Google Calendar ไม่สำเร็จ</strong><p>{calendarError || `กรุณาเชื่อมบัญชี ${data?.calendarName || authorizedEmail}`} แล้วกด “Sync ทันที” อีกครั้ง</p></div>
          <button type="button" onClick={syncCalendar} disabled={syncing}>{syncing ? "กำลัง Sync…" : "Sync ทันที"}</button>
        </div>
      )}

      {lastSyncedAt && data?.calendarConnected && <p className="last-sync" role="status">อัปเดตจาก Google Calendar ล่าสุด {new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Bangkok" }).format(lastSyncedAt)} น. · ข้อมูลเดิม {data.importedCount} เคส</p>}

      {notice && <div className={`notice ${notice.type}`} role="alert">{notice.text}</div>}

      {bookingConflict && (
        <div className="queue-conflict-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setBookingConflict(null)}>
          <section className="queue-conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="queue-conflict-title" aria-describedby="queue-conflict-message">
            <button ref={conflictCloseRef} className="queue-conflict-close" type="button" aria-label="ปิดคำเตือน" onClick={() => setBookingConflict(null)}>×</button>
            <span className="queue-conflict-icon" aria-hidden="true">!</span>
            <div className="queue-conflict-heading">
              <span>ไม่สามารถลงคิวที่เลือกได้</span>
              <h3 id="queue-conflict-title">กรุณาเลือกคิวใหม่</h3>
              <p id="queue-conflict-message">{bookingConflict.message}</p>
            </div>
            {bookingConflict.suggestions.length > 0 ? (
              <div className="queue-suggestion-list" aria-label="วันที่และห้องผ่าตัดที่แนะนำ">
                <strong>คิวที่ว่างและตรงเกณฑ์</strong>
                {bookingConflict.suggestions.map((suggestion) => (
                  <button type="button" key={`${suggestion.date}:${suggestion.queueType}`} onClick={() => chooseSuggestedQueue(suggestion)}>
                    <span><b>{displayDate(suggestion.date, true)}</b><small>{suggestion.queueType === "EXTRA" ? "OR Extra" : "OR 17"}</small></span>
                    <span>ว่าง {suggestion.availableSlots} เคส <b>เลือกคิวนี้ →</b></span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="queue-suggestion-empty">ยังไม่พบคิวอื่นที่ตรงทุกเงื่อนไขในช่วง 12 เดือน กรุณาปิดหน้าต่างแล้วเปลี่ยนเงื่อนไข Staff หรือเลือก “ห้องไหนก็ได้ที่ยังว่าง”</p>
            )}
            <small className="queue-conflict-footnote">การเลือกจากรายการนี้ยังไม่บันทึกคิว กรุณาตรวจสอบข้อมูลแล้วกด “ตรวจสอบและบันทึกคิว” อีกครั้ง</small>
          </section>
        </div>
      )}

      {showSyncPrompt && (
        <div className="queue-conflict-backdrop" role="presentation">
          <section className="queue-conflict-dialog sync-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="sync-prompt-title" aria-describedby="sync-prompt-message">
            <span className="sync-confirm-icon" aria-hidden="true">↻</span>
            <span>บันทึกคิวสำเร็จ</span>
            <h3 id="sync-prompt-title">กด Sync ทันที เพื่อบันทึกลงใน Calendar</h3>
            <p id="sync-prompt-message">ระบบส่งรายการเข้าปฏิทินแล้ว การ Sync จะดึงข้อมูลล่าสุดกลับมายืนยันบนหน้าเว็บ</p>
            <button ref={syncPromptButtonRef} type="button" onClick={() => void confirmSyncAfterBooking()} disabled={syncing}>{syncing ? "กำลัง Sync…" : "↻ Sync ทันที"}</button>
          </section>
        </div>
      )}

      {pendingClosure && (
        <div className="queue-conflict-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setPendingClosure(null)}>
          <section className="queue-conflict-dialog closure-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="closure-confirm-title" aria-describedby="closure-confirm-message">
            <span className="queue-conflict-icon" aria-hidden="true">!</span>
            <div className="queue-conflict-heading">
              <span>พบคิวเดิมในวันที่ต้องการปิด</span>
              <h3 id="closure-confirm-title">ยืนยันปิดรับเฉพาะคิวใหม่</h3>
              <p id="closure-confirm-message">{pendingClosure.message}</p>
            </div>
            <div className="closure-affected-list" aria-label="คิวเดิมที่จะคงไว้">
              {pendingClosure.bookings.map((booking) => (
                <article key={booking.id}>
                  <b>{booking.queueType === "EXTRA" ? "OR Extra" : "OR 17"} #{booking.slotNo}</b>
                  <span>{booking.operation}</span>
                  <small>{booking.patientName} · HN ••••{booking.hn.slice(-4)} · {staffLabel(booking.staffMembers)}</small>
                </article>
              ))}
            </div>
            <div className="closure-confirm-actions">
              <button type="button" onClick={() => setPendingClosure(null)}>กลับไปตรวจสอบ</button>
              <button ref={closureConfirmRef} type="button" onClick={() => void saveClosure(true)} disabled={closureSaving}>{closureSaving ? "กำลังบันทึก…" : `ยืนยันและคงคิวเดิม ${pendingClosure.bookings.length} เคส`}</button>
            </div>
          </section>
        </div>
      )}

      <div className="workspace-grid">
        <section className="panel booking-panel">
          <div className="panel-heading">
            <div><span className="step">01</span><h3>ข้อมูลผู้ป่วยและการผ่าตัด</h3></div>
            <span className={`diagnosis-badge ${cancer ? "cancer" : "general"}`}>{cancer ? `Cancer · ${form.cancerSchedulingMode === "specific" ? "ระบุวันเอง" : "คิวเร็วที่สุด"}` : "OR 17 · เลือกวัน"}</span>
          </div>

          <form onSubmit={submitBooking} noValidate>
            <label className="field full"><span>Diagnosis <b>*</b></span><input value={form.diagnosis} onChange={(e) => updateField("diagnosis", e.target.value)} placeholder="เช่น DCIS, Breast Cancer, CA breast, CA thyroid" autoComplete="off" /><small className="field-help">คำที่ระบบจัดเป็น Cancer: DCIS, Cancer, CA breast, CA thyroid และ Thyroid cancer</small></label>
            {cancer && <fieldset className="cancer-mode"><legend>การเลือกคิวสำหรับ Cancer</legend><div className="mode-options"><label aria-label="คิวเร็วที่สุด" htmlFor="cancer-mode-earliest" className={form.cancerSchedulingMode === "earliest" ? "selected" : ""}><input id="cancer-mode-earliest" type="radio" name="cancerSchedulingMode" value="earliest" checked={form.cancerSchedulingMode === "earliest"} onChange={() => setForm((current) => ({ ...current, cancerSchedulingMode: "earliest", dateEntryMode: "list", requestedDate: "", requestedQueueType: "" }))} /><span><strong>คิวเร็วที่สุด</strong><small>ให้ระบบเลือกคิวว่างแรกอัตโนมัติ</small></span></label><label aria-label="ระบุวันเอง" htmlFor="cancer-mode-specific" className={form.cancerSchedulingMode === "specific" ? "selected" : ""}><input id="cancer-mode-specific" type="radio" name="cancerSchedulingMode" value="specific" checked={form.cancerSchedulingMode === "specific"} onChange={() => setForm((current) => ({ ...current, cancerSchedulingMode: "specific", dateEntryMode: "list", requestedDate: "", requestedQueueType: "OR17" }))} /><span><strong>ระบุวันเอง</strong><small>เลือก OR 17 หรือ OR Extra ที่ยังว่าง</small></span></label></div></fieldset>}
            {cancer && form.cancerSchedulingMode === "earliest" && nextCancerDay && <div className="cancer-suggestion"><span>คิวว่างเร็วที่สุด</span><strong>{displayDate(nextCancerDay.date)} · {nextCancerDay.queueType === "EXTRA" ? "OR Extra" : "OR 17"}</strong><small>ระบบจะตรวจคิวล่าสุดอีกครั้งเมื่อกดบันทึก</small></div>}
            {cancer && form.cancerSchedulingMode === "earliest" && form.staffMembers.length > 0 && form.staffQueuePreference === "same_staff" && !nextCancerDay && <div className="staff-queue-empty" role="status">ไม่พบคิวว่างในช่วง 12 เดือนที่ Staff ที่เลือกมีเคสอยู่แล้ว กรุณาเลือก “ห้องไหนก็ได้ที่ยังว่าง” หรือระบุวันเอง</div>}
            <div className="form-grid">
              <label className="field"><span>HN <b>*</b></span><input value={form.hn} onChange={(e) => updateField("hn", e.target.value)} inputMode="numeric" placeholder="Hospital number" /></label>
              <label className="field"><span>Tel <b>*</b></span><input value={form.phone} onChange={(e) => updateField("phone", e.target.value)} inputMode="tel" placeholder="เบอร์โทรศัพท์" /></label>
              <label className="field"><span>ชื่อ <b>*</b></span><input value={form.firstName} onChange={(e) => updateField("firstName", e.target.value)} placeholder="ชื่อผู้ป่วย" /></label>
              <label className="field"><span>สกุล <b>*</b></span><input value={form.lastName} onChange={(e) => updateField("lastName", e.target.value)} placeholder="นามสกุล" /></label>
              <label className="field full"><span>Operation <b>*</b></span><input value={form.operation} onChange={(e) => updateField("operation", e.target.value)} placeholder="ชื่อหัตถการ / การผ่าตัด" /></label>
              <label className="field full neoadjuvant-field"><span>Neoadjuvant treatment</span><span className="neoadjuvant-choice"><input type="checkbox" checked={form.neoadjuvantTreatment} onChange={(event) => setForm((current) => ({ ...current, neoadjuvantTreatment: event.target.checked }))} />เคยได้รับการรักษาแบบ neoadjuvant มาก่อน</span><small className="field-help">หากไม่เลือก ระบบจะบันทึกว่า “ไม่ได้รับ”</small></label>
              <label className="field full note-field"><span>หมายเหตุ</span><textarea value={form.note} onChange={(e) => updateField("note", e.target.value)} placeholder="ระบุรายละเอียดเพิ่มเติม (ถ้ามี)" maxLength={1000} rows={3} /></label>
              <div className="field staff-field">
                <fieldset className="staff-selector" aria-describedby="staff-help">
                  <legend>Staff <b>*</b></legend>
                  <div>
                    {STAFF.map((staff) => <label key={staff}><input type="checkbox" checked={form.staffMembers.includes(staff)} onChange={() => toggleStaffMember(staff)} /><span>{staff}</span></label>)}
                  </div>
                  <small id="staff-help">เลือกได้มากกว่า 1 คน โดย Staff คนแรกตามลำดับรายชื่อจะเป็นผู้กำหนดสีใน Google Calendar</small>
                </fieldset>
                {form.staffMembers.length > 0 && (
                  <>
                    <fieldset className="staff-queue-preference">
                      <legend>เลือกห้องตามคิวของ Staff</legend>
                      <div role="group" aria-label="เงื่อนไขเลือกห้องผ่าตัดตาม Staff">
                        <button type="button" aria-pressed={form.staffQueuePreference === "same_staff"} className={form.staffQueuePreference === "same_staff" ? "active" : ""} onClick={() => chooseStaffQueuePreference("same_staff")}>ห้องที่ Staff มีเคสแล้ว</button>
                        <button type="button" aria-pressed={form.staffQueuePreference === "any"} className={form.staffQueuePreference === "any" ? "active" : ""} onClick={() => chooseStaffQueuePreference("any")}>ห้องไหนก็ได้ที่ยังว่าง</button>
                      </div>
                      <small>{form.staffQueuePreference === "same_staff" ? `พบคิวว่างที่ Staff ที่เลือกอย่างน้อย 1 คนมีเคสแล้ว ${availableDays.length} คิว` : "แสดงทุกห้องผ่าตัดที่ยังว่างตามกติกา"}</small>
                    </fieldset>
                    <section className="staff-smart-search" aria-label={`Smart search คิวผ่าตัดของ ${staffLabel(form.staffMembers)}`} aria-live="polite">
                      <div className="staff-smart-heading">
                        <div><span>SMART SEARCH</span><strong>คิวผ่าตัดของ {staffLabel(form.staffMembers)}</strong></div>
                        {!staffScheduleLoading && !staffScheduleError && <b>{staffUpcomingCases.length} เคส</b>}
                      </div>
                      {staffScheduleLoading ? <p className="staff-smart-state">กำลังค้นหาคิวผ่าตัด…</p>
                        : staffScheduleError ? <p className="staff-smart-state error">{staffScheduleError}</p>
                          : staffUpcomingCases.length === 0 ? <p className="staff-smart-state">ยังไม่มีคิวผ่าตัดที่กำลังจะมาถึง</p>
                            : <div className="staff-smart-list">
                              {staffUpcomingCases.map((booking) => (
                                <article key={booking.id}>
                                  <div className="staff-smart-date">
                                    <strong>{displayDate(booking.scheduleDate, true)}</strong>
                                    <small>{booking.queueType === "EXTRA" ? "OR Extra" : "OR 17"} · {displaySlotTime(booking.slotNo)}</small>
                                  </div>
                                  <dl>
                                    <div><dt>Diagnosis</dt><dd>{booking.diagnosis || "ไม่ระบุ"}</dd></div>
                                    <div><dt>Operation</dt><dd>{booking.operation || "ไม่ระบุ"}</dd></div>
                                    <div><dt>Staff</dt><dd>{staffLabel(booking.staffMembers)}</dd></div>
                                  </dl>
                                </article>
                              ))}
                            </div>}
                      <small className="staff-smart-privacy">แสดงเฉพาะ Diagnosis และ Operation · ไม่แสดงชื่อ สกุล หรือ HN</small>
                    </section>
                  </>
                )}
              </div>
              <div className={`field date-choice-field ${cancer && form.cancerSchedulingMode === "earliest" ? "muted-field" : ""}`}>
                <span>วันที่ผ่าตัด {(!cancer || form.cancerSchedulingMode === "specific") && <b>*</b>}</span>
                {cancer && form.cancerSchedulingMode === "earliest" ? (
                  <select value="" disabled aria-label="ระบบเลือกคิวเร็วที่สุด"><option>ระบบเลือกคิวเร็วที่สุด</option></select>
                ) : (
                  <>
                    <div className="date-entry-toggle" role="group" aria-label="วิธีเลือกวันที่ผ่าตัด">
                      <button type="button" className={form.dateEntryMode === "list" ? "active" : ""} onClick={() => setDateEntryMode("list")}>เลือกจากคิวว่าง</button>
                      <button type="button" className={form.dateEntryMode === "manual" ? "active" : ""} onClick={() => setDateEntryMode("manual")}>ระบุวันเอง</button>
                    </div>
                    {form.dateEntryMode === "list" ? (
                      cancer ? (
                        <select value={form.requestedDate && form.requestedQueueType ? `${form.requestedDate}|${form.requestedQueueType}` : ""} onChange={(e) => chooseCancerDate(e.target.value)} aria-label="เลือกวันและประเภทคิว">
                          <option value="">{cancerDates.length ? "เลือกวันและประเภทคิว" : "ไม่พบคิวว่างตามเงื่อนไข Staff"}</option>
                          {cancerDates.map((day) => <option key={`${day.date}:${day.queueType}`} value={`${day.date}|${day.queueType}`}>{displayDate(day.date, true)} · {day.queueType === "EXTRA" ? "OR Extra" : "OR 17"} · ว่าง {day.capacity - day.count}</option>)}
                        </select>
                      ) : (
                        <select value={form.requestedDate} onChange={(e) => setForm((current) => ({ ...current, requestedDate: e.target.value, requestedQueueType: "OR17" }))} aria-label="เลือกวัน OR 17">
                          <option value="">{normalDates.length ? "เลือกวัน OR 17" : "ไม่พบคิวว่างตามเงื่อนไข Staff"}</option>
                          {normalDates.map((day) => <option key={day.date} value={day.date}>{displayDate(day.date, true)} · ว่าง {day.capacity - day.count}</option>)}
                        </select>
                      )
                    ) : (
                      <div className={`manual-date-grid ${cancer ? "" : "single"}`}>
                        <input type="date" min={manualDateStart} max={data?.horizonEnd} value={form.requestedDate} onChange={(e) => chooseManualDate(e.target.value)} aria-label={`ระบุวันที่ผ่าตัดเอง เริ่มตั้งแต่ ${displayDate(manualDateStart)} ถึง ${data?.horizonEnd ? displayDate(data.horizonEnd) : "สิ้นสุดช่วงที่เปิดให้ลงคิว"}`} />
                        {cancer ? (
                          <select value={form.requestedQueueType || "OR17"} onChange={(e) => updateField("requestedQueueType", e.target.value)} aria-label="เลือกห้องผ่าตัด">
                            <option value="OR17">OR 17</option>
                            <option value="EXTRA">OR Extra</option>
                          </select>
                        ) : <span className="fixed-room">OR 17</span>}
                      </div>
                    )}
                    {form.dateEntryMode === "manual" && <small className="field-help">เริ่มเลือกได้ตั้งแต่ {displayDate(manualDateStart)} ซึ่งเป็นวันถัดจากคิวว่างสุดท้ายใน Drop-down ถึง {data?.horizonEnd ? displayDate(data.horizonEnd) : "สิ้นสุดช่วง 12 เดือน"}</small>}
                  </>
                )}
              </div>
            </div>
            {selectedSurgeryDate && waitingDays !== null && (
              <div className="wait-time-card" role="status">
                <div><span>ระยะเวลารอคิว</span><strong>{waitingDays} วัน</strong></div>
                <p>นับจากวันที่ลงคิว {displayDate(queuedDate, true)}<br />{displayDate(selectedSurgeryDate)} · {selectedQueueType === "EXTRA" ? "OR Extra" : "OR 17"}</p>
              </div>
            )}
            <div className="privacy-note"><span>●</span> ข้อมูล HN ชื่อ และ Tel จะแสดงเฉพาะในรายละเอียดกิจกรรมของปฏิทิน ไม่แสดงในชื่อกิจกรรม</div>
            <button className="save-button" type="submit" disabled={saving}>{saving ? "กำลังตรวจคิวและบันทึก…" : "ตรวจสอบและบันทึกคิว"}<span>→</span></button>
          </form>
        </section>

        <aside className="panel schedule-panel">
          <div className="panel-heading compact"><div><span className="step">02</span><h3>{scheduleView === "closures" ? "ตั้งค่าวันปิดรับคิว" : "คิวที่กำลังจะมาถึง"}</h3></div>{scheduleView !== "closures" && <button className="text-button" type="button" onClick={() => setShowExtra(!showExtra)}>+ กำหนด OR Extra</button>}</div>
          <div className="schedule-tabs" role="tablist" aria-label="รูปแบบแสดงตารางผ่าตัด">
            <button type="button" role="tab" aria-selected={scheduleView === "list"} className={scheduleView === "list" ? "active" : ""} onClick={() => setScheduleView("list")}>รายการคิว</button>
            <button type="button" role="tab" aria-selected={scheduleView === "month"} className={scheduleView === "month" ? "active" : ""} onClick={() => setScheduleView("month")}>ปฏิทินรายเดือน</button>
            <button type="button" role="tab" aria-selected={scheduleView === "closures"} className={scheduleView === "closures" ? "active" : ""} onClick={() => { setScheduleView("closures"); setShowExtra(false); }}>วันปิดรับคิว</button>
          </div>
          <section className="wait-time-export" aria-label="Export ข้อมูลระยะเวลารอผ่าตัด">
            <div><strong>Export Excel เวลารอผ่าตัด</strong><small>ไม่รวม HN ชื่อ และเบอร์โทร</small></div>
            <label><span>วันผ่าตัดตั้งแต่</span><input type="date" value={exportRange.from} onChange={(event) => setExportRange((current) => ({ ...current, from: event.target.value }))} /></label>
            <label><span>ถึง</span><input type="date" value={exportRange.to} onChange={(event) => setExportRange((current) => ({ ...current, to: event.target.value }))} /></label>
            <button type="button" onClick={() => void exportWaitingTime()} disabled={exporting}>{exporting ? "กำลัง Export…" : "↓ Download Excel"}</button>
          </section>
          {showExtra && <form className="extra-form" onSubmit={submitExtra}><label><span>วันที่ (จันทร์/พฤหัสบดี)</span><input type="date" min={data?.horizonStart} max={data?.horizonEnd} value={extra.date} onChange={(e) => setExtra({ ...extra, date: e.target.value })} /></label><div className="extra-fixed-capacity"><span>จำนวนเคส</span><strong>4 เคส</strong><small>เท่ากับ OR 17 และไม่สามารถเปลี่ยนได้</small></div><label className="wide"><span>หมายเหตุ</span><input value={extra.note} onChange={(e) => setExtra({ ...extra, note: e.target.value })} placeholder="เช่น Extra Breast OR" /></label><button type="submit">บันทึกวัน Extra</button></form>}
          {scheduleView === "list" ? (
            <div className="schedule-list" role="tabpanel" aria-label="รายการคิวที่กำลังจะมาถึง">
              {loading && <div className="empty-state">กำลังโหลดคิว…</div>}
              {!loading && upcomingDays.length === 0 && <div className="empty-state">ยังไม่มีวันผ่าตัดที่เปิดรับคิว</div>}
              {upcomingDays.map((day) => {
                const rows = bookingsByDay.get(`${day.date}:${day.queueType}`) || [];
                const remaining = day.capacity - day.count;
                const needsCancer = day.queueType === "OR17" && day.count === 3 && day.cancerCount === 0;
                return <article className={`day-card ${day.queueType === "EXTRA" ? "extra" : ""} ${day.closed ? "closed" : ""}`} key={`${day.date}:${day.queueType}`}>
                  <div className="date-block"><strong>{new Date(`${day.date}T12:00:00+07:00`).getDate()}</strong><span>{new Intl.DateTimeFormat("th-TH", { month: "short" }).format(new Date(`${day.date}T12:00:00+07:00`))}</span></div>
                  <div className="day-main"><div className="day-title"><div><strong>{day.queueType === "EXTRA" ? "OR Extra" : "OR 17"}</strong><span>{displayDate(day.date, true)} · {day.note}</span></div><em>{day.count}/{day.capacity}</em></div>
                    <div className="capacity-bar"><i style={{ width: `${Math.min(100, (day.count / day.capacity) * 100)}%` }} /></div>
                    {day.closed && <p className="closure-line">ปิดรับคิว · {day.closureName}{day.closureNote ? ` — ${day.closureNote}` : ""}</p>}
                    {needsCancer && <p className="warning-line">ช่องสุดท้ายรับ Cancer เท่านั้น</p>}
                    {day.queueType === "EXTRA" && <p className="extra-line">รับเฉพาะ Diagnosis ที่ระบุ Cancer · สูงสุด 4 เคส</p>}
                    {rows.length > 0 && <div className="mini-bookings">{rows.map((row) => <div key={row.id}><span className={row.isCancer ? "cancer-mark" : ""}>#{row.slotNo}</span><p><strong>{row.operation}</strong><small>{displaySlotTime(row.slotNo)} · HN ••••{row.hn.slice(-4)} · {staffLabel(row.staffMembers)}</small></p><StatusDot synced={row.calendarSyncStatus === "synced"} /></div>)}</div>}
                    {remaining <= 0 && <span className="full-label">คิวเต็ม</span>}
                  </div>
                </article>;
              })}
            </div>
          ) : scheduleView === "month" ? (
            <div role="tabpanel" aria-label="ปฏิทินผ่าตัดรายเดือน">
              <MonthlyCalendar days={data?.days || []} bookings={data?.bookings || []} closures={data?.closures || []} horizonStart={data?.horizonStart || bangkokToday()} horizonEnd={data?.horizonEnd || bangkokToday()} month={calendarMonth} selectedDate={selectedCalendarDate} onMonthChange={setCalendarMonth} onSelectDate={setSelectedCalendarDate} />
            </div>
          ) : (
            <div className="closure-manager" role="tabpanel" aria-label="ตั้งค่าวันปิดรับคิว">
              <form className="closure-form" onSubmit={submitClosure}>
                <div className="closure-form-heading"><strong>{closureForm.id ? "แก้ไขวันปิดรับคิว" : "เพิ่มวันปิดรับคิว"}</strong><small>ปิดทั้ง OR 17 และ OR Extra</small></div>
                <label><span>วันที่ <b>*</b></span><input type="date" min={data?.horizonStart} max={data?.horizonEnd} value={closureForm.date} onChange={(event) => setClosureForm((current) => ({ ...current, date: event.target.value }))} required /></label>
                <label><span>ชื่อวันปิด <b>*</b></span><input value={closureForm.name} maxLength={120} onChange={(event) => setClosureForm((current) => ({ ...current, name: event.target.value }))} placeholder="เช่น วันรัฐธรรมนูญ" required /></label>
                <label className="wide"><span>หมายเหตุ</span><textarea value={closureForm.note} maxLength={500} onChange={(event) => setClosureForm((current) => ({ ...current, note: event.target.value }))} placeholder="รายละเอียดเพิ่มเติมหรือเหตุผลที่ปิดรับคิว" /></label>
                <div className="closure-form-actions">
                  {closureForm.id && <button type="button" onClick={() => setClosureForm(EMPTY_CLOSURE_FORM)}>ยกเลิกแก้ไข</button>}
                  <button type="submit" disabled={closureSaving}>{closureSaving ? "กำลังบันทึก…" : closureForm.id ? "บันทึกการแก้ไข" : "เพิ่มวันปิดรับคิว"}</button>
                </div>
              </form>
              <div className="closure-list-toolbar">
                <strong>รายการวันปิดรับคิว <span>{data?.closures.length || 0}</span></strong>
                <input type="search" value={closureSearch} onChange={(event) => setClosureSearch(event.target.value)} placeholder="ค้นหาวัน ชื่อ หรือหมายเหตุ" aria-label="ค้นหาวันปิดรับคิว" />
              </div>
              <div className="closure-list" aria-live="polite">
                {filteredClosures.length === 0 ? <p>ไม่พบวันปิดรับคิว</p> : filteredClosures.map((closure) => {
                  const affectedCount = (data?.bookings || []).filter((booking) => booking.scheduleDate === closure.date).length;
                  return <article key={closure.id}>
                    <div className="closure-date"><strong>{Number(closure.date.slice(-2))}</strong><span>{new Intl.DateTimeFormat("th-TH", { month: "short", year: "numeric" }).format(new Date(`${closure.date}T12:00:00+07:00`))}</span></div>
                    <div className="closure-detail"><strong>{closure.name}</strong><span>{closure.note || "ไม่มีหมายเหตุ"}</span><small>แก้ไขล่าสุด {closure.updatedAt ? new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(closure.updatedAt)) : "ไม่ระบุเวลา"}{affectedCount ? ` · มีคิวเดิม ${affectedCount} เคส` : ""}</small></div>
                    <div className="closure-row-actions"><button type="button" onClick={() => editClosure(closure)}>แก้ไข</button><button type="button" onClick={() => void deleteClosure(closure)} disabled={closureSaving}>ลบ</button></div>
                  </article>;
                })}
              </div>
            </div>
          )}
        </aside>
      </div>

      <section className="case-tools-grid" aria-label="ค้นหาและประวัติการสลับวันผ่าตัด">
        <div className="panel case-search-panel">
          <div className="panel-heading compact">
            <div><span className="step">03</span><h3>ค้นหาเคสและสลับวันผ่าตัด</h3></div>
            <span className="search-scope">HN · ชื่อ · สกุล</span>
          </div>
          <form className="case-search-form" onSubmit={searchCases}>
            <label htmlFor="case-search">ค้นหาจากเคสใน Google Calendar</label>
            <div>
              <input id="case-search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="พิมพ์ HN ชื่อ หรือสกุล" autoComplete="off" />
              <button type="submit" disabled={searching}>{searching ? "กำลังค้นหา…" : "ค้นหา"}</button>
            </div>
          </form>

          <div className="case-results" aria-live="polite">
            {searched && !searching && searchResults.length === 0 && <div className="case-empty">ไม่พบเคสที่ตรงกับคำค้น</div>}
            {searchResults.map((result) => (
              <article className={`case-result ${selectedCase?.id === result.id ? "selected" : ""}`} key={result.id}>
                <button type="button" onClick={() => { setSelectedCase(result); setMoveTarget(""); }}>
                  <span className="case-identity"><strong>{result.patientName}</strong><small>HN {result.hn} · {result.diagnosis}</small></span>
                  <span className="case-current"><strong>{displayDate(result.scheduleDate, true)}</strong><small>{result.queueType === "EXTRA" ? "OR Extra" : `OR 17 · ช่อง ${result.slotNo}`}</small></span>
                  <span className="case-operation">{result.operation}<small>{staffLabel(result.staffMembers)}</small></span>
                  <span className="select-case">{selectedCase?.id === result.id ? "เลือกแล้ว" : "เลือกสลับวัน"}</span>
                </button>
                {selectedCase?.id === result.id && (
                  <form className="move-form" onSubmit={moveCase}>
                    <label htmlFor={`move-${result.id}`}>วันผ่าตัดใหม่</label>
                    <select id={`move-${result.id}`} value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)}>
                      <option value="">เลือกคิวปลายทางที่ยังว่าง</option>
                      {moveDates.map((day) => <option key={`${day.date}:${day.queueType}`} value={`${day.date}|${day.queueType}`}>{displayDate(day.date, true)} · {day.queueType === "EXTRA" ? "OR Extra" : "OR 17"} · ว่าง {day.capacity - day.count}</option>)}
                    </select>
                    <button type="submit" disabled={moving || !moveTarget}>{moving ? "กำลังอัปเดต Calendar…" : "ยืนยันสลับวัน"}</button>
                    <small>ระบบจะตรวจจำนวนคิวและกติกา Cancer อีกครั้งก่อนย้าย</small>
                  </form>
                )}
              </article>
            ))}
          </div>
        </div>

        <aside className="panel move-history-panel">
          <div className="panel-heading compact"><div><span className="step">04</span><h3>แจ้งเตือนการสลับวันล่าสุด</h3></div><span className="history-count">{data?.recentMoves.length || 0}/10</span></div>
          <div className="move-history-list">
            {(data?.recentMoves || []).length === 0 && <div className="case-empty">ยังไม่มีการสลับวันผ่าตัด</div>}
            {(data?.recentMoves || []).map((move) => (
              <article key={move.id}>
                <div><strong>{move.patientName}</strong><small>HN ••••{move.hn.slice(-4)} · {move.operation}</small></div>
                <p><span>{displayDate(move.fromDate, true)}</span><b>→</b><span>{displayDate(move.toDate, true)}</span></p>
                <time dateTime={move.movedAt}>{new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(move.movedAt))}</time>
              </article>
            ))}
          </div>
        </aside>
      </section>

      <footer><span>Breast &amp; Endocrine Surgery CMU</span><p>ข้อมูลผู้ป่วยเป็นความลับ · กรุณาใช้งานผ่านบัญชีที่ได้รับอนุญาตเท่านั้น</p></footer>
    </main>
  );
}
