"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import type { CalendarStatus } from "../lib/admin-calendar-api";
import {
  type ApiResult,
  NETWORK_MESSAGE,
  describeSwitchOutcome,
  isFreshLock,
  isStatus,
  parseApiError,
  readApiResponse,
  decideAfterSwitch,
  canSwitchNow,
  switchBlockReason,
  parseDiagnostics,
  type DiagnosticsView,
} from "./calendar-ui";

type Notice = { type: "success" | "error"; text: string; hint?: string; dev?: string } | null;
type Preview = {
  tokenOnly: boolean;
  counts: Record<string, number>;
  skipped: number;
  recurring: number;
  byMonth: Record<string, number>;
  targetEventCount: number;
  targetHasEvents: boolean;
  // app events in the target that the current master no longer has (switching would resurrect them)
  targetConflicts: number;
  // source events whose ids Google will not accept with the same id: copied under a new id (does not block)
  invalidIds: number;
  // occurrences of copied recurring events that the switch will move (modify) or cancel
  exceptions: { modify: number; cancel: number };
  // occurrences the app shows that the copy plan does not cover (must be 0; the server refuses otherwise)
  uncoveredOccurrences: number;
  // fixed Thai refusal from the server's plan, or null
  planBlocked: string | null;
  // read-only breakdown for the developer; null when the server sent none
  diagnostics: DiagnosticsView | null;
};
type Dialog = { kind: "switch" | "clearLock"; fresh: boolean } | null;

const API = "/api/admin/calendar";
const COUNT_LABELS: Record<string, string> = {
  booking: "คิวผ่าตัด",
  extra_day: "วัน OR Extra",
  schedule_closure: "วันปิดรับคิว",
  staff_unavailable: "Staff ไม่ว่าง",
  legacy: "รายการเดิม",
};

const REASON_LABELS: Record<keyof DiagnosticsView["reasons"], string> = {
  uppercase: "มีตัวพิมพ์ใหญ่",
  hyphen: "มีเครื่องหมาย -",
  underscore: "มีเครื่องหมาย _",
  tooShort: "สั้นกว่า 5 ตัวอักษร",
  tooLong: "ยาวเกิน 1024 ตัวอักษร",
  otherChars: "มีอักขระอื่น (เช่น w-z)",
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function toPreview(body: Record<string, unknown> | null): Preview | null {
  if (!body) return null;
  if (body.tokenOnly === true) {
    return { tokenOnly: true, counts: {}, skipped: 0, recurring: 0, byMonth: {}, targetEventCount: 0, targetHasEvents: false, targetConflicts: 0, invalidIds: 0, exceptions: { modify: 0, cancel: 0 }, uncoveredOccurrences: 0, planBlocked: null, diagnostics: null };
  }
  if (typeof body.counts !== "object" || body.counts === null) return null;
  return {
    tokenOnly: false,
    counts: body.counts as Record<string, number>,
    skipped: num(body.skipped),
    recurring: num(body.recurring),
    byMonth: typeof body.byMonth === "object" && body.byMonth ? (body.byMonth as Record<string, number>) : {},
    targetEventCount: num(body.targetEventCount),
    targetHasEvents: body.targetHasEvents === true,
    targetConflicts: num(body.targetConflicts),
    invalidIds: num(body.invalidIds),
    exceptions: {
      modify: num((body.exceptions as { modify?: unknown } | null | undefined)?.modify),
      cancel: num((body.exceptions as { cancel?: unknown } | null | undefined)?.cancel),
    },
    uncoveredOccurrences: num(body.uncoveredOccurrences),
    planBlocked: typeof body.planBlocked === "string" && body.planBlocked ? body.planBlocked : null,
    diagnostics: parseDiagnostics(body.diagnostics),
  };
}

// Admin: master calendar. All state shown is what the server answered; the refresh token is read from an
// uncontrolled field at submit, cleared on the spot and never kept in state, echoed or logged.
export default function AdminCalendar({ initial }: { initial: CalendarStatus | null }) {
  const [status, setStatus] = useState<CalendarStatus | null>(initial);
  const [busy, setBusy] = useState<"" | "connect" | "preview" | "switch" | "clearLock" | "reload">("");
  const [notice, setNotice] = useState<Notice>(initial ? null : { type: "error", text: "อ่านสถานะปฏิทินไม่สำเร็จ กรุณากด “โหลดสถานะใหม่”" });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [email, setEmail] = useState("");
  const [calendarId, setCalendarId] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [lockAck, setLockAck] = useState(false);
  const busyRef = useRef(false);
  const tokenRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const isBusy = busy !== "";

  // Dialog: focus "ยกเลิก" on open; Esc closes it unless a request is running; focus returns to the trigger.
  useEffect(() => {
    if (!dialog) return;
    cancelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        closeDialog();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialog]);

  function closeDialog() {
    setDialog(null);
    setLockAck(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function openDialog(kind: "switch" | "clearLock", trigger: HTMLElement) {
    if (busyRef.current || !status) return;
    triggerRef.current = trigger;
    setLockAck(false);
    setDialog({ kind, fresh: kind === "clearLock" && isFreshLock(status, Date.now()) });
  }

  // One request at a time: the ref blocks a second click before React has re-rendered the disabled state.
  async function call(action: NonNullable<typeof busy>, body: Record<string, unknown> | null): Promise<ApiResult | null> {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(action);
    setNotice(null);
    try {
      const response = await fetch(API, {
        method: body ? "POST" : "GET",
        cache: "no-store",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return await readApiResponse(response);
    } catch {
      return { status: 0, ok: false, nonJson: false, body: { error: NETWORK_MESSAGE } };
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  async function reloadStatus(): Promise<CalendarStatus | null> {
    const result = await call("reload", null);
    if (result?.ok && isStatus(result.body)) {
      setStatus(result.body);
      return result.body;
    }
    if (result) setNotice({ type: "error", text: parseApiError(result) });
    return null;
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const field = tokenRef.current;
    const refreshToken = field?.value ?? "";
    if (field) field.value = ""; // cleared before the request, so success and failure both leave it empty
    if (!email.trim() || !calendarId.trim() || !refreshToken.trim()) {
      setNotice({ type: "error", text: "กรุณากรอกอีเมล รหัสปฏิทิน และ refresh token ให้ครบ" });
      return;
    }
    const result = await call("connect", { action: "connect", email: email.trim(), calendarId: calendarId.trim(), refreshToken });
    if (!result) return;
    if (result.ok && isStatus(result.body)) {
      setStatus(result.body);
      setPreview(null);
      setEmail("");
      setCalendarId("");
      setNotice({ type: "success", text: "เชื่อมต่อปฏิทินใหม่แล้ว กด “ตรวจตัวอย่างก่อนสลับ” เพื่อดูจำนวนข้อมูล" });
    } else {
      setNotice({ type: "error", text: parseApiError(result) });
    }
  }

  async function runPreview() {
    const result = await call("preview", { action: "preview" });
    if (!result) return;
    const parsed = result.ok ? toPreview(result.body) : null;
    if (parsed) {
      setPreview(parsed);
      setNotice({ type: "success", text: parsed.tokenOnly ? "ปฏิทินใหม่คือปฏิทินหลักเดิม จะต่ออายุ token เท่านั้น" : "ตรวจตัวอย่างแล้ว ตรวจตัวเลขก่อนกดสลับ" });
    } else {
      setPreview(null);
      setNotice({ type: "error", text: parseApiError(result) });
    }
  }

  async function confirmSwitch() {
    if (busyRef.current || !status?.candidate) return;
    const former = status.candidate;
    setDialog(null);
    const result = await call("switch", { action: "switch" });
    if (!result) return;
    const outcome = describeSwitchOutcome(result);
    // The answer may be missing (network, timeout, 502 page) or partial: the status is always re-read from the server.
    const fresh = await reloadStatus();
    const decision = decideAfterSwitch(outcome, fresh, former);
    // A preflight refusal means the preview no longer matches the calendars: press preview again.
    if (!decision.keepPreview || result.body?.step === "preflight") setPreview(null);
    setNotice(decision.notice);
  }

  async function confirmClearLock() {
    if (busyRef.current) return;
    setDialog(null);
    const result = await call("clearLock", { action: "clearLock" });
    if (!result) return;
    if (result.ok && isStatus(result.body)) {
      setStatus(result.body);
      setNotice({ type: "success", text: "ปลดล็อกแล้ว" });
    } else {
      setNotice({ type: "error", text: parseApiError(result) });
    }
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  const copying = busy === "switch";
  const canSwitch = canSwitchNow(status, preview);
  const blockReason = switchBlockReason(preview);
  const months = preview ? Object.entries(preview.byMonth).sort(([a], [b]) => a.localeCompare(b)) : [];

  return (
    <section className="panel admin-panel admin-calendar" aria-labelledby="admin-calendar-title" aria-busy={isBusy}>
      <h2 id="admin-calendar-title">ปฏิทินหลัก (Google Calendar)</h2>
      <p className="admin-calendar-intro">
        หลังสลับปฏิทิน ทุกคนต้องแก้ข้อมูลผ่านแอปเท่านั้น ห้ามเพิ่มหรือลากเคสใน Google Calendar โดยตรง
      </p>

      {status ? (
        <dl className="admin-calendar-status">
          <div>
            <dt>ปฏิทินหลักตอนนี้</dt>
            <dd>
              <strong>{status.master.email}</strong>
              <small>{status.master.calendarId}{status.master.source === "env" ? " · ตั้งต้นจาก env" : ""}</small>
            </dd>
          </div>
          {status.candidate && (
            <div>
              <dt>ปฏิทินใหม่ที่เชื่อมไว้</dt>
              <dd><strong>{status.candidate.email}</strong><small>{status.candidate.calendarId}</small></dd>
            </div>
          )}
          {status.previousMaster && (
            <div>
              <dt>ปฏิทินก่อนหน้า</dt>
              <dd><strong>{status.previousMaster.email}</strong><small>{status.previousMaster.calendarId}</small></dd>
            </div>
          )}
          {!status.keyConfigured && <div><dt>คำเตือน</dt><dd><strong>ยังไม่ได้ตั้งค่า CALENDAR_SETTINGS_KEY</strong></dd></div>}
        </dl>
      ) : null}

      {status?.locked && (
        <div className="admin-calendar-lock">
          <p>ระบบล็อกอยู่ เพราะกำลังสลับปฏิทิน (หรือการสลับก่อนหน้าค้าง)</p>
          <button type="button" className="admin-reload" disabled={isBusy} onClick={(event) => openDialog("clearLock", event.currentTarget)}>ปลดล็อก</button>
        </div>
      )}

      <form className="admin-calendar-form" onSubmit={connect} noValidate autoComplete="off">
        <label className="field">
          <span>อีเมล Google ของปฏิทินใหม่</span>
          <input type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} disabled={isBusy} />
        </label>
        <label className="field">
          <span>รหัสปฏิทิน (calendar id)</span>
          <input type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} value={calendarId} onChange={(e) => setCalendarId(e.target.value)} disabled={isBusy} />
        </label>
        <label className="field">
          <span>refresh token</span>
          <input ref={tokenRef} type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} name="calendar-grant" disabled={isBusy} />
        </label>
        <button type="submit" disabled={isBusy} aria-busy={busy === "connect"}>{busy === "connect" ? "กำลังตรวจสอบ…" : "เชื่อมต่อปฏิทินใหม่"}</button>
      </form>

      <div className="admin-calendar-actions">
        <button type="button" className="admin-reload" disabled={isBusy || !status?.candidate} onClick={() => void runPreview()}>
          {busy === "preview" ? "กำลังตรวจ…" : "ตรวจตัวอย่างก่อนสลับ"}
        </button>
        <button type="button" className="admin-reload" disabled={isBusy} onClick={() => void reloadStatus()}>โหลดสถานะใหม่</button>
      </div>

      {preview && (
        <div className="admin-calendar-preview">
          {preview.tokenOnly ? (
            <p>ปฏิทินใหม่คือปฏิทินหลักเดิม การสลับจะต่ออายุ token เท่านั้น ไม่คัดลอกข้อมูล</p>
          ) : (
            <>
              <table>
                <caption>ข้อมูลที่จะคัดลอก</caption>
                <tbody>
                  {Object.entries(COUNT_LABELS).map(([key, label]) => (
                    <tr key={key}><th scope="row">{label}</th><td>{num(preview.counts[key])}</td></tr>
                  ))}
                  <tr><th scope="row">ข้ามไป</th><td>{preview.skipped}</td></tr>
                  <tr><th scope="row">รายการซ้ำ (recurring)</th><td>{preview.recurring}</td></tr>
                  <tr><th scope="row">รายการในปฏิทินปลายทางที่ปฏิทินหลักไม่มีแล้ว</th><td>{preview.targetConflicts}</td></tr>
                  <tr><th scope="row">รหัส event ที่ต้องออกรหัสใหม่ (ไม่บล็อก)</th><td>{preview.invalidIds}</td></tr>
                  <tr>
                    <th scope="row">รายการยกเว้นของรายการซ้ำที่จะคัดลอก</th>
                    <td>ย้าย/แก้ไข {preview.exceptions.modify} · ยกเลิก {preview.exceptions.cancel}</td>
                  </tr>
                  <tr><th scope="row">รายการที่แอปแสดงแต่ไม่อยู่ในแผนคัดลอก (ต้องเป็น 0)</th><td>{preview.uncoveredOccurrences}</td></tr>
                </tbody>
              </table>
              {preview.diagnostics && (
                <details className="admin-calendar-diagnostics">
                  <summary>รายละเอียดสำหรับนักพัฒนา</summary>
                  <p className="admin-calendar-diagnostics-title">รหัส event ที่ต้องออกรหัสใหม่ ({preview.invalidIds}) คัดลอกด้วยรหัสใหม่ และเก็บรหัสเดิมไว้ใน orig_id</p>
                  <ul>
                    {Object.entries(REASON_LABELS).map(([key, label]) => (
                      <li key={key}>{label}: {preview.diagnostics?.reasons[key as keyof DiagnosticsView["reasons"]]}</li>
                    ))}
                    <li>เป็นรายการของแอป: {preview.diagnostics.byKind.app} · รายการเดิม: {preview.diagnostics.byKind.legacy} · รายการซ้ำต้นแบบ: {preview.diagnostics.byKind.recurringMasters}</li>
                  </ul>
                  {preview.diagnostics.shapes.length > 0 && (
                    <p className="admin-calendar-diagnostics-shapes">
                      รูปแบบรหัส (ย่อเป็นความยาวของแต่ละช่วง: l = ตัวพิมพ์เล็ก/เลข, U = ตัวพิมพ์ใหญ่/เลข, ? = อักขระอื่น; เครื่องหมายขีด/ขีดล่าง/จุด ฯลฯ แสดงตามจริง และ … หมายถึงตัดให้สั้น): {preview.diagnostics.shapes.map((x) => `${x.shape} (${x.count})`).join(" · ")}
                      {preview.diagnostics.shapesOmitted > 0 ? ` · ไม่อยู่ในรายการ ${preview.diagnostics.shapesOmitted} รหัส` : ""}
                    </p>
                  )}
                  <p className="admin-calendar-diagnostics-title">รายการซ้ำ (recurring)</p>
                  <ul>
                    <li>ต้นแบบ: {preview.diagnostics.recurring.masters} (อยู่ในแผนคัดลอก {preview.diagnostics.recurring.mastersPlanned}) · ไม่มีวันสิ้นสุด: {preview.diagnostics.recurring.infiniteMasters}</li>
                    <li>รายการยกเว้น: {preview.diagnostics.recurring.exceptionInstances} (ยกเลิกแล้ว {preview.diagnostics.recurring.exceptionsCancelled})</li>
                    <li>รายการต้นแบบที่มีวันยกเว้น/วันเพิ่ม (EXDATE/RDATE/EXRULE): {preview.diagnostics.recurring.rruleExtras} · รายการยกเว้นที่ไม่ตรงกับวันใดของรายการซ้ำ (ไม่คัดลอก ไม่บล็อก): {preview.diagnostics.orphanedExceptions}</li>
                    <li>ความถี่: รายวัน {preview.diagnostics.recurring.byFreq.DAILY} · รายสัปดาห์ {preview.diagnostics.recurring.byFreq.WEEKLY} · รายเดือน {preview.diagnostics.recurring.byFreq.MONTHLY} · รายปี {preview.diagnostics.recurring.byFreq.YEARLY} · อื่น ๆ {preview.diagnostics.recurring.byFreq.other}</li>
                  </ul>
                  <p className="admin-calendar-diagnostics-title">สาเหตุที่ข้าม ({preview.skipped})</p>
                  <ul>
                    <li>ยกเลิกแล้ว: {preview.diagnostics.skippedReasons.cancelled} · รายการยกเว้นของ recurring: {preview.diagnostics.skippedReasons.recurringException} · แอปอ่านไม่ได้: {preview.diagnostics.skippedReasons.notReadable}</li>
                  </ul>
                </details>
              )}
              {months.length > 0 && (
                <p className="admin-calendar-months">แยกตามเดือน: {months.map(([m, n]) => `${m} (${n})`).join(" · ")}</p>
              )}
              {preview.targetHasEvents && (
                <p className="admin-calendar-warning">ปฏิทินปลายทางไม่ว่าง: มี {preview.targetEventCount} รายการอยู่แล้ว ตรวจให้แน่ใจว่าเป็นปฏิทินที่ถูกต้อง</p>
              )}
              {blockReason && <p className="admin-calendar-warning" role="alert">{blockReason}</p>}
            </>
          )}
        </div>
      )}

      <div className="admin-calendar-actions">
        <button type="button" className="admin-calendar-switch" disabled={isBusy || !canSwitch} onClick={(event) => openDialog("switch", event.currentTarget)}>
          สลับปฏิทินหลัก
        </button>
      </div>

      {copying && (
        <p className="admin-calendar-busy" role="status" aria-live="polite">กำลังคัดลอก… (ใช้เวลาได้หลายนาที ห้ามปิดหน้านี้)</p>
      )}
      <p className={`admin-notice ${notice?.type || ""}`} role="status" aria-live="polite">
        {notice?.text || ""}
        {notice?.hint ? <><br />{notice.hint}</> : null}
      </p>
      {notice?.dev ? <p className="admin-calendar-dev"><small>{notice.dev}</small></p> : null}

      {dialog && (
        <div className="queue-conflict-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !isBusy && closeDialog()}>
          <section className="queue-conflict-dialog closure-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="calendar-dialog-title" aria-describedby="calendar-dialog-body">
            <div className="queue-conflict-heading">
              <h3 id="calendar-dialog-title">{dialog.kind === "switch" ? "สลับปฏิทินหลัก" : "ปลดล็อกการสลับปฏิทิน"}</h3>
              <div id="calendar-dialog-body" className="admin-calendar-dialog-body">
                {dialog.kind === "switch" ? (
                  <>
                    <p>
                      ระหว่างสลับ ระบบจะหยุดการบันทึกประมาณ 10–15 นาที ห้ามปิดหน้านี้ ปฏิทินเดิมจะไม่ถูกแก้ไข
                      และจะถูกบันทึกเป็นปฏิทินก่อนหน้า
                    </p>
                    <p>หลังสลับแล้ว ทุกคนต้องแก้ข้อมูลผ่านแอปเท่านั้น ห้ามแก้ไขใน Google Calendar โดยตรง</p>
                    {preview && !preview.tokenOnly && (
                      <p>
                        จะคัดลอก {Object.values(preview.counts).reduce((a, b) => a + num(b), 0)} รายการ
                        {preview.exceptions.modify + preview.exceptions.cancel ? ` และรายการยกเว้นของรายการซ้ำ ${preview.exceptions.modify + preview.exceptions.cancel} รายการ` : ""}
                        {preview.skipped ? ` (ข้าม ${preview.skipped})` : ""}
                        {preview.targetHasEvents ? ` · ปฏิทินปลายทางมี ${preview.targetEventCount} รายการอยู่แล้ว` : ""}
                      </p>
                    )}
                    {preview?.tokenOnly && <p>เป็นการต่ออายุ token ของปฏิทินเดิม ไม่คัดลอกข้อมูล</p>}
                  </>
                ) : (
                  <>
                    <p>การปลดล็อกขณะที่การสลับยังทำงานอยู่ อาจตัดการสลับที่กำลังทำงานอยู่ให้ขาดกลางคัน ปลดล็อกเมื่อแน่ใจว่าไม่มีการสลับค้างอยู่เท่านั้น</p>
                    {dialog.fresh && (
                      <label className="admin-calendar-ack">
                        <input type="checkbox" checked={lockAck} onChange={(e) => setLockAck(e.target.checked)} disabled={isBusy} />
                        <span>ล็อกนี้เพิ่งเกิดไม่ถึง 1 นาที ฉันยืนยันว่าไม่มีการสลับกำลังทำงานอยู่</span>
                      </label>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="closure-confirm-actions">
              <button ref={cancelRef} type="button" onClick={closeDialog} disabled={isBusy}>ยกเลิก</button>
              {dialog.kind === "switch" ? (
                <button type="button" onClick={() => void confirmSwitch()} disabled={isBusy}>ยืนยันสลับปฏิทิน</button>
              ) : (
                <button type="button" onClick={() => void confirmClearLock()} disabled={isBusy || (dialog.fresh && !lockAck)}>ปลดล็อก</button>
              )}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
