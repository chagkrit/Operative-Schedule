"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";

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
  calendarConnected: boolean;
  calendarName: string;
  error?: string;
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
  hn: "",
  firstName: "",
  lastName: "",
  phone: "",
  operation: "",
  staff: "",
  requestedDate: "",
  requestedQueueType: "",
};

function isCancer(value: string) {
  return /(^|[^a-z])cancer([^a-z]|$)/i.test(value.trim());
}

function displayDate(value: string, short = false) {
  return new Intl.DateTimeFormat("th-TH", {
    weekday: short ? "short" : "long",
    day: "numeric",
    month: short ? "short" : "long",
    year: short ? undefined : "numeric",
  }).format(new Date(`${value}T12:00:00+07:00`));
}

function StatusDot({ synced }: { synced: boolean }) {
  return <span className={`status-dot ${synced ? "synced" : "pending"}`} aria-hidden="true" />;
}

export default function SchedulerApp() {
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showExtra, setShowExtra] = useState(false);
  const [extra, setExtra] = useState({ date: "", capacity: "4", note: "" });

  const loadSchedule = useCallback(async () => {
    try {
      const response = await fetch("/api/schedule", { cache: "no-store" });
      const payload = (await response.json()) as ScheduleResponse;
      if (!response.ok) throw new Error(payload.error || "โหลดตารางคิวไม่สำเร็จ");
      setData(payload);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "โหลดข้อมูลไม่สำเร็จ" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSchedule(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSchedule]);

  const cancer = isCancer(form.diagnosis);
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
  const bookingsByDay = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const booking of data?.bookings || []) {
      const key = `${booking.scheduleDate}:${booking.queueType}`;
      map.set(key, [...(map.get(key) || []), booking]);
    }
    return map;
  }, [data]);

  function updateField(name: keyof typeof EMPTY_FORM, value: string) {
    setForm((current) => ({ ...current, [name]: value } as typeof EMPTY_FORM));
    setNotice(null);
  }

  function chooseCancerDate(value: string) {
    const [requestedDate = "", requestedQueueType = ""] = value.split("|");
    setForm((current) => ({ ...current, requestedDate, requestedQueueType }));
    setNotice(null);
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
        body: JSON.stringify({ ...extra, capacity: Number(extra.capacity) }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "กำหนดวันไม่สำเร็จ");
      setNotice({ type: "success", text: payload.message || "กำหนด OR Extra แล้ว" });
      setExtra({ date: "", capacity: "4", note: "" });
      setShowExtra(false);
      await loadSchedule();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "กำหนดวันไม่สำเร็จ" });
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
        <div className={`calendar-pill ${data?.calendarConnected ? "connected" : "disconnected"}`}>
          <StatusDot synced={Boolean(data?.calendarConnected)} />
          <span>{data?.calendarConnected ? `เชื่อมแล้ว · ${data.calendarName}` : "รอเชื่อม Google Calendar"}</span>
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

      {!loading && data && !data.calendarConnected && (
        <div className="setup-banner" role="status">
          <span className="banner-icon">!</span>
          <div><strong>เว็บไซต์พร้อมแล้ว แต่ยังไม่เปิดรับข้อมูลผู้ป่วย</strong><p>เชื่อมบัญชี {data.calendarName} ก่อน ระบบจึงจะอนุญาตให้กดบันทึก เพื่อป้องกันคิวตกหล่นจากปฏิทิน</p></div>
        </div>
      )}

      {notice && <div className={`notice ${notice.type}`} role="alert">{notice.text}</div>}

      <div className="workspace-grid">
        <section className="panel booking-panel">
          <div className="panel-heading">
            <div><span className="step">01</span><h3>ข้อมูลผู้ป่วยและการผ่าตัด</h3></div>
            <span className={`diagnosis-badge ${cancer ? "cancer" : "general"}`}>{cancer ? `Cancer · ${form.cancerSchedulingMode === "specific" ? "ระบุวันเอง" : "คิวเร็วที่สุด"}` : "OR 17 · เลือกวัน"}</span>
          </div>

          <form onSubmit={submitBooking} noValidate>
            <label className="field full"><span>Diagnosis <b>*</b></span><input value={form.diagnosis} onChange={(e) => updateField("diagnosis", e.target.value)} placeholder="เช่น Breast Cancer" autoComplete="off" /></label>
            {cancer && <fieldset className="cancer-mode"><legend>การเลือกคิวสำหรับ Cancer</legend><div className="mode-options"><label aria-label="คิวเร็วที่สุด" htmlFor="cancer-mode-earliest" className={form.cancerSchedulingMode === "earliest" ? "selected" : ""}><input id="cancer-mode-earliest" type="radio" name="cancerSchedulingMode" value="earliest" checked={form.cancerSchedulingMode === "earliest"} onChange={() => setForm((current) => ({ ...current, cancerSchedulingMode: "earliest", requestedDate: "", requestedQueueType: "" }))} /><span><strong>คิวเร็วที่สุด</strong><small>ให้ระบบเลือกคิวว่างแรกอัตโนมัติ</small></span></label><label aria-label="ระบุวันเอง" htmlFor="cancer-mode-specific" className={form.cancerSchedulingMode === "specific" ? "selected" : ""}><input id="cancer-mode-specific" type="radio" name="cancerSchedulingMode" value="specific" checked={form.cancerSchedulingMode === "specific"} onChange={() => setForm((current) => ({ ...current, cancerSchedulingMode: "specific", requestedDate: "", requestedQueueType: "" }))} /><span><strong>ระบุวันเอง</strong><small>เลือก OR 17 หรือ OR Extra ที่ยังว่าง</small></span></label></div></fieldset>}
            {cancer && form.cancerSchedulingMode === "earliest" && nextCancerDay && <div className="cancer-suggestion"><span>คิวว่างเร็วที่สุด</span><strong>{displayDate(nextCancerDay.date)} · {nextCancerDay.queueType === "EXTRA" ? "OR Extra" : "OR 17"}</strong><small>ระบบจะตรวจคิวล่าสุดอีกครั้งเมื่อกดบันทึก</small></div>}
            <div className="form-grid">
              <label className="field"><span>HN <b>*</b></span><input value={form.hn} onChange={(e) => updateField("hn", e.target.value)} inputMode="numeric" placeholder="Hospital number" /></label>
              <label className="field"><span>Tel <b>*</b></span><input value={form.phone} onChange={(e) => updateField("phone", e.target.value)} inputMode="tel" placeholder="เบอร์โทรศัพท์" /></label>
              <label className="field"><span>ชื่อ <b>*</b></span><input value={form.firstName} onChange={(e) => updateField("firstName", e.target.value)} placeholder="ชื่อผู้ป่วย" /></label>
              <label className="field"><span>สกุล <b>*</b></span><input value={form.lastName} onChange={(e) => updateField("lastName", e.target.value)} placeholder="นามสกุล" /></label>
              <label className="field full"><span>Operation <b>*</b></span><input value={form.operation} onChange={(e) => updateField("operation", e.target.value)} placeholder="ชื่อหัตถการ / การผ่าตัด" /></label>
              <label className="field"><span>Staff <b>*</b></span><select value={form.staff} onChange={(e) => updateField("staff", e.target.value)}><option value="">เลือก Staff</option>{STAFF.map((staff) => <option key={staff}>{staff}</option>)}</select></label>
              {cancer ? <label className={`field ${form.cancerSchedulingMode === "earliest" ? "muted-field" : ""}`}><span>วันที่ผ่าตัด {form.cancerSchedulingMode === "specific" && <b>*</b>}</span><select value={form.requestedDate && form.requestedQueueType ? `${form.requestedDate}|${form.requestedQueueType}` : ""} onChange={(e) => chooseCancerDate(e.target.value)} disabled={form.cancerSchedulingMode === "earliest"}><option value="">{form.cancerSchedulingMode === "earliest" ? "ระบบเลือกคิวเร็วที่สุด" : "เลือกวันและประเภทคิว"}</option>{cancerDates.map((day) => <option key={`${day.date}:${day.queueType}`} value={`${day.date}|${day.queueType}`}>{displayDate(day.date, true)} · {day.queueType === "EXTRA" ? "OR Extra" : "OR 17"} · ว่าง {day.capacity - day.count}</option>)}</select></label> : <label className="field"><span>วันที่ผ่าตัด <b>*</b></span><select value={form.requestedDate} onChange={(e) => setForm((current) => ({ ...current, requestedDate: e.target.value, requestedQueueType: "OR17" }))}><option value="">เลือกวัน OR 17</option>{normalDates.map((day) => <option key={day.date} value={day.date}>{displayDate(day.date, true)} · ว่าง {day.capacity - day.count}</option>)}</select></label>}
            </div>
            <div className="privacy-note"><span>●</span> ข้อมูล HN ชื่อ และ Tel จะแสดงเฉพาะในรายละเอียดกิจกรรมของปฏิทิน ไม่แสดงในชื่อกิจกรรม</div>
            <button className="save-button" type="submit" disabled={saving}>{saving ? "กำลังตรวจคิวและบันทึก…" : "ตรวจสอบและบันทึกคิว"}<span>→</span></button>
          </form>
        </section>

        <aside className="panel schedule-panel">
          <div className="panel-heading compact"><div><span className="step">02</span><h3>คิวที่กำลังจะมาถึง</h3></div><button className="text-button" type="button" onClick={() => setShowExtra(!showExtra)}>+ กำหนด OR Extra</button></div>
          {showExtra && <form className="extra-form" onSubmit={submitExtra}><label><span>วันที่ (จันทร์/พฤหัสบดี)</span><input type="date" value={extra.date} onChange={(e) => setExtra({ ...extra, date: e.target.value })} /></label><label><span>จำนวนเคส</span><input type="number" min="1" max="8" value={extra.capacity} onChange={(e) => setExtra({ ...extra, capacity: e.target.value })} /></label><label className="wide"><span>หมายเหตุ</span><input value={extra.note} onChange={(e) => setExtra({ ...extra, note: e.target.value })} placeholder="เช่น Extra Breast OR" /></label><button type="submit">บันทึกวัน Extra</button></form>}
          <div className="schedule-list">
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
                  {day.queueType === "EXTRA" && <p className="extra-line">รับเฉพาะ Diagnosis ที่ระบุ Cancer</p>}
                  {rows.length > 0 && <div className="mini-bookings">{rows.map((row) => <div key={row.id}><span className={row.isCancer ? "cancer-mark" : ""}>#{row.slotNo}</span><p><strong>{row.operation}</strong><small>HN ••••{row.hn.slice(-4)} · {row.staff}</small></p><StatusDot synced={row.calendarSyncStatus === "synced"} /></div>)}</div>}
                  {remaining === 0 && <span className="full-label">คิวเต็ม</span>}
                </div>
              </article>;
            })}
          </div>
        </aside>
      </div>

      <footer><span>Breast &amp; Endocrine Surgery CMU</span><p>ข้อมูลผู้ป่วยเป็นความลับ · กรุณาใช้งานผ่านบัญชีที่ได้รับอนุญาตเท่านั้น</p></footer>
    </main>
  );
}
