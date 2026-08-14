"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
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
};

type Booking = {
  id: string;
  scheduleDate: string;
  queueType: "OR17" | "EXTRA";
  slotNo: number;
  diagnosis: string;
  isCancer: boolean;
  hn: string;
  patientName: string;
  operation: string;
  staff: string;
  calendarSyncStatus: "pending" | "synced" | "failed";
};

type ScheduleResponse = {
  days: Day[];
  bookings: Booking[];
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
  operation: string;
  staff: string;
  scheduleDate: string;
  queueType: "OR17" | "EXTRA";
  slotNo: number;
};

const STAFF = [
  "อ อารีวรรณ",
  "อ กีรติ",
  "อ ปัญจพร",
  "อ จักรกริช",
  "อ จุฬารัตน์",
  "อ ณิชกานต์",
];

const EMPTY_FORM = {
  diagnosis: "",
  cancerSchedulingMode: "earliest" as "earliest" | "specific",
  dateEntryMode: "list" as "list" | "manual",
  hn: "",
  firstName: "",
  lastName: "",
  phone: "",
  operation: "",
  staff: "",
  requestedDate: "",
  requestedQueueType: "",
};

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

function displayMonth(value: string) {
  return new Intl.DateTimeFormat("th-TH", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  }).format(new Date(`${value}-15T12:00:00+07:00`));
}

type MonthlyCalendarProps = {
  days: Day[];
  bookings: Booking[];
  month: string;
  selectedDate: string;
  onMonthChange: (value: string) => void;
  onSelectDate: (value: string) => void;
};

function MonthlyCalendar({ days, bookings, month, selectedDate, onMonthChange, onSelectDate }: MonthlyCalendarProps) {
  const availableMonths = [...new Set(days.map((day) => day.date.slice(0, 7)))];
  const monthIndex = availableMonths.indexOf(month);
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const summariesByDate = new Map<string, Day[]>();
  for (const day of days) {
    summariesByDate.set(day.date, [...(summariesByDate.get(day.date) || []), day]);
  }
  const cells = [
    ...Array.from({ length: firstWeekday }, () => ""),
    ...Array.from({ length: daysInMonth }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`),
  ];
  while (cells.length % 7 !== 0) cells.push("");
  const selectedSummaries = summariesByDate.get(selectedDate) || [];
  const selectedCount = selectedSummaries.reduce((total, day) => total + day.count, 0);
  const selectedBookings = bookings
    .filter((booking) => booking.scheduleDate === selectedDate)
    .sort((a, b) => a.queueType === b.queueType ? a.slotNo - b.slotNo : a.queueType === "OR17" ? -1 : 1);
  const today = bangkokToday();

  function changeMonth(direction: -1 | 1) {
    const target = availableMonths[monthIndex + direction];
    if (!target) return;
    onMonthChange(target);
    onSelectDate(`${target}-01`);
  }

  return (
    <div className="monthly-calendar">
      <div className="month-toolbar">
        <button type="button" onClick={() => changeMonth(-1)} disabled={monthIndex <= 0} aria-label="เดือนก่อนหน้า">‹</button>
        <strong>{displayMonth(month)}</strong>
        <button type="button" onClick={() => changeMonth(1)} disabled={monthIndex < 0 || monthIndex >= availableMonths.length - 1} aria-label="เดือนถัดไป">›</button>
      </div>
      <div className="month-grid" role="grid" aria-label={`ปฏิทิน ${displayMonth(month)}`}>
        {['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'].map((label) => <span className="month-weekday" key={label}>{label}</span>)}
        {cells.map((date, index) => {
          if (!date) return <span className="month-blank" key={`blank-${index}`} />;
          const summaries = summariesByDate.get(date) || [];
          const count = summaries.reduce((total, day) => total + day.count, 0);
          const hasExtra = summaries.some((day) => day.queueType === "EXTRA");
          return (
            <button
              type="button"
              className={`month-day ${date === selectedDate ? "selected" : ""} ${date === today ? "today" : ""} ${hasExtra ? "has-extra" : ""}`}
              key={date}
              onClick={() => onSelectDate(date)}
              aria-label={`${displayDate(date)} ${count} เคส`}
              aria-pressed={date === selectedDate}
            >
              <span>{Number(date.slice(-2))}</span>
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
        {selectedSummaries.length > 0 ? selectedSummaries.map((day) => (
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
                  <small>{booking.diagnosis} · {booking.staff} · {booking.queueType === "EXTRA" ? "OR Extra" : "OR 17"}</small>
                </div>
                <StatusDot synced={booking.calendarSyncStatus === "synced"} />
              </article>
            ))}
          </div>
        ) : <p className="month-bookings-empty">ยังไม่มีเคสลงคิวในวันที่เลือก</p>}
      </section>
      <p className="month-legend"><span /> วันที่มี OR Extra <b>ตัวเลขในวงกลม = จำนวนเคส</b></p>
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
  const [scheduleView, setScheduleView] = useState<"list" | "month">("list");
  const [calendarMonth, setCalendarMonth] = useState(() => bangkokToday().slice(0, 7));
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => bangkokToday());
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [selectedCase, setSelectedCase] = useState<SearchResult | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [moving, setMoving] = useState(false);

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

  const cancer = diagnosisIsCancer(form.diagnosis);
  const normalDates = useMemo(
    () => data?.days.filter((day) => day.queueType === "OR17" && day.count < day.capacity) || [],
    [data],
  );
  const cancerDates = useMemo(
    () => data?.days.filter((day) => day.count < day.capacity) || [],
    [data],
  );
  const upcomingDays = data?.days.slice(0, 8) || [];
  const nextCancerDay = useMemo(
    () => data?.days.find((day) => day.count < day.capacity),
    [data],
  );
  const selectedSurgeryDate = cancer && form.cancerSchedulingMode === "earliest"
    ? nextCancerDay?.date || ""
    : form.requestedDate;
  const selectedQueueType = cancer && form.cancerSchedulingMode === "earliest"
    ? nextCancerDay?.queueType || ""
    : form.requestedQueueType || (!cancer ? "OR17" : "");
  const waitingDays = selectedSurgeryDate ? daysBetween(bangkokToday(), selectedSurgeryDate) : null;
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
      if (day.count >= day.capacity) return false;
      if (day.date === selectedCase.scheduleDate && day.queueType === selectedCase.queueType) return false;
      if (!selectedCase.isCancer && day.queueType !== "OR17") return false;
      if (!selectedCase.isCancer && day.queueType === "OR17" && day.count === 3 && day.cancerCount === 0) return false;
      return true;
    });
  }, [data, selectedCase]);

  function updateField(name: keyof typeof EMPTY_FORM, value: string) {
    setForm((current) => ({ ...current, [name]: value } as typeof EMPTY_FORM));
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

  async function syncCalendar() {
    setSyncing(true);
    setNotice(null);
    try {
      await loadSchedule(true);
    } finally {
      setSyncing(false);
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
      staff: "Staff",
    };
    const missing = Object.entries(labels)
      .filter(([key]) => !form[key as keyof typeof form].trim())
      .map(([, label]) => label);
    if ((!cancer || form.cancerSchedulingMode === "specific") && !form.requestedDate) {
      missing.push("วันที่ผ่าตัด");
    }
    if (missing.length) {
      setNotice({ type: "error", text: `ยังบันทึกไม่ได้ กรุณากรอก: ${missing.join(", ")}` });
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
      const payload = (await response.json()) as { error?: string; message?: string; booking?: { date: string; queueType: string } };
      if (!response.ok) throw new Error(payload.error || "บันทึกไม่สำเร็จ");
      const room = payload.booking?.queueType === "EXTRA" ? "OR Extra" : "OR 17";
      setNotice({ type: "success", text: `${payload.message} • ${displayDate(payload.booking!.date, true)} • ${room}` });
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
          <form action={signOutAction}><button className="signout-button" type="submit">ออกจากระบบ</button></form>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow pink">SURGICAL SCHEDULING</p>
          <h2>ลงคิวผ่าตัด<br /><span>ชัดเจน ปลอดภัย ไม่ชนกัน</span></h2>
          <p className="hero-copy">ระบบจัดคิว OR 17 และ OR Extra ตามเกณฑ์ของหน่วย พร้อมส่งรายการเข้าปฏิทินกลางทันทีหลังบันทึก</p>
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
            <div className="form-grid">
              <label className="field"><span>HN <b>*</b></span><input value={form.hn} onChange={(e) => updateField("hn", e.target.value)} inputMode="numeric" placeholder="Hospital number" /></label>
              <label className="field"><span>Tel <b>*</b></span><input value={form.phone} onChange={(e) => updateField("phone", e.target.value)} inputMode="tel" placeholder="เบอร์โทรศัพท์" /></label>
              <label className="field"><span>ชื่อ <b>*</b></span><input value={form.firstName} onChange={(e) => updateField("firstName", e.target.value)} placeholder="ชื่อผู้ป่วย" /></label>
              <label className="field"><span>สกุล <b>*</b></span><input value={form.lastName} onChange={(e) => updateField("lastName", e.target.value)} placeholder="นามสกุล" /></label>
              <label className="field full"><span>Operation <b>*</b></span><input value={form.operation} onChange={(e) => updateField("operation", e.target.value)} placeholder="ชื่อหัตถการ / การผ่าตัด" /></label>
              <label className="field"><span>Staff <b>*</b></span><select value={form.staff} onChange={(e) => updateField("staff", e.target.value)}><option value="">เลือก Staff</option>{STAFF.map((staff) => <option key={staff}>{staff}</option>)}</select></label>
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
                          <option value="">เลือกวันและประเภทคิว</option>
                          {cancerDates.map((day) => <option key={`${day.date}:${day.queueType}`} value={`${day.date}|${day.queueType}`}>{displayDate(day.date, true)} · {day.queueType === "EXTRA" ? "OR Extra" : "OR 17"} · ว่าง {day.capacity - day.count}</option>)}
                        </select>
                      ) : (
                        <select value={form.requestedDate} onChange={(e) => setForm((current) => ({ ...current, requestedDate: e.target.value, requestedQueueType: "OR17" }))} aria-label="เลือกวัน OR 17">
                          <option value="">เลือกวัน OR 17</option>
                          {normalDates.map((day) => <option key={day.date} value={day.date}>{displayDate(day.date, true)} · ว่าง {day.capacity - day.count}</option>)}
                        </select>
                      )
                    ) : (
                      <div className={`manual-date-grid ${cancer ? "" : "single"}`}>
                        <input type="date" min={bangkokToday()} value={form.requestedDate} onChange={(e) => chooseManualDate(e.target.value)} aria-label="ระบุวันที่ผ่าตัดเอง" />
                        {cancer ? (
                          <select value={form.requestedQueueType || "OR17"} onChange={(e) => updateField("requestedQueueType", e.target.value)} aria-label="เลือกห้องผ่าตัด">
                            <option value="OR17">OR 17</option>
                            <option value="EXTRA">OR Extra</option>
                          </select>
                        ) : <span className="fixed-room">OR 17</span>}
                      </div>
                    )}
                    {form.dateEntryMode === "manual" && <small className="field-help">เลือกวันในอนาคตได้โดยไม่จำกัดช่วงเวลา เช่น มกราคม 2570 โดยระบบจะตรวจวันที่ ห้องผ่าตัด และจำนวนคิวก่อนบันทึก</small>}
                  </>
                )}
              </div>
            </div>
            {selectedSurgeryDate && waitingDays !== null && (
              <div className="wait-time-card" role="status">
                <div><span>ระยะเวลารอคิว</span><strong>{waitingDays} วัน</strong></div>
                <p>{displayDate(selectedSurgeryDate)} · {selectedQueueType === "EXTRA" ? "OR Extra" : "OR 17"}</p>
              </div>
            )}
            <div className="privacy-note"><span>●</span> ข้อมูล HN ชื่อ และ Tel จะแสดงเฉพาะในรายละเอียดกิจกรรมของปฏิทิน ไม่แสดงในชื่อกิจกรรม</div>
            <button className="save-button" type="submit" disabled={saving}>{saving ? "กำลังตรวจคิวและบันทึก…" : "ตรวจสอบและบันทึกคิว"}<span>→</span></button>
          </form>
        </section>

        <aside className="panel schedule-panel">
          <div className="panel-heading compact"><div><span className="step">02</span><h3>คิวที่กำลังจะมาถึง</h3></div><button className="text-button" type="button" onClick={() => setShowExtra(!showExtra)}>+ กำหนด OR Extra</button></div>
          <div className="schedule-tabs" role="tablist" aria-label="รูปแบบแสดงตารางผ่าตัด">
            <button type="button" role="tab" aria-selected={scheduleView === "list"} className={scheduleView === "list" ? "active" : ""} onClick={() => setScheduleView("list")}>รายการคิว</button>
            <button type="button" role="tab" aria-selected={scheduleView === "month"} className={scheduleView === "month" ? "active" : ""} onClick={() => setScheduleView("month")}>ปฏิทินรายเดือน</button>
          </div>
          {showExtra && <form className="extra-form" onSubmit={submitExtra}><label><span>วันที่ (จันทร์/พฤหัสบดี)</span><input type="date" value={extra.date} onChange={(e) => setExtra({ ...extra, date: e.target.value })} /></label><div className="extra-fixed-capacity"><span>จำนวนเคส</span><strong>4 เคส</strong><small>เท่ากับ OR 17 และไม่สามารถเปลี่ยนได้</small></div><label className="wide"><span>หมายเหตุ</span><input value={extra.note} onChange={(e) => setExtra({ ...extra, note: e.target.value })} placeholder="เช่น Extra Breast OR" /></label><button type="submit">บันทึกวัน Extra</button></form>}
          {scheduleView === "list" ? (
            <div className="schedule-list" role="tabpanel" aria-label="รายการคิวที่กำลังจะมาถึง">
              {loading && <div className="empty-state">กำลังโหลดคิว…</div>}
              {!loading && upcomingDays.length === 0 && <div className="empty-state">ยังไม่มีวันผ่าตัดที่เปิดรับคิว</div>}
              {upcomingDays.map((day) => {
                const rows = bookingsByDay.get(`${day.date}:${day.queueType}`) || [];
                const remaining = day.capacity - day.count;
                const needsCancer = day.queueType === "OR17" && day.count === 3 && day.cancerCount === 0;
                return <article className={`day-card ${day.queueType === "EXTRA" ? "extra" : ""}`} key={`${day.date}:${day.queueType}`}>
                  <div className="date-block"><strong>{new Date(`${day.date}T12:00:00+07:00`).getDate()}</strong><span>{new Intl.DateTimeFormat("th-TH", { month: "short" }).format(new Date(`${day.date}T12:00:00+07:00`))}</span></div>
                  <div className="day-main"><div className="day-title"><div><strong>{day.queueType === "EXTRA" ? "OR Extra" : "OR 17"}</strong><span>{displayDate(day.date, true)} · {day.note}</span></div><em>{day.count}/{day.capacity}</em></div>
                    <div className="capacity-bar"><i style={{ width: `${Math.min(100, (day.count / day.capacity) * 100)}%` }} /></div>
                    {needsCancer && <p className="warning-line">ช่องสุดท้ายรับ Cancer เท่านั้น</p>}
                    {day.queueType === "EXTRA" && <p className="extra-line">รับเฉพาะ Diagnosis ที่ระบุ Cancer · สูงสุด 4 เคส</p>}
                    {rows.length > 0 && <div className="mini-bookings">{rows.map((row) => <div key={row.id}><span className={row.isCancer ? "cancer-mark" : ""}>#{row.slotNo}</span><p><strong>{row.operation}</strong><small>{displaySlotTime(row.slotNo)} · HN ••••{row.hn.slice(-4)} · {row.staff}</small></p><StatusDot synced={row.calendarSyncStatus === "synced"} /></div>)}</div>}
                    {remaining <= 0 && <span className="full-label">คิวเต็ม</span>}
                  </div>
                </article>;
              })}
            </div>
          ) : (
            <div role="tabpanel" aria-label="ปฏิทินผ่าตัดรายเดือน">
              <MonthlyCalendar days={data?.days || []} bookings={data?.bookings || []} month={calendarMonth} selectedDate={selectedCalendarDate} onMonthChange={setCalendarMonth} onSelectDate={setSelectedCalendarDate} />
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
                  <span className="case-operation">{result.operation}<small>{result.staff}</small></span>
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
