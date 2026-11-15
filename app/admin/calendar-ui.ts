// Pure helpers for the Admin master-calendar screen (no React, no network): response parsing, the fixed
// Thai outcome texts, and the post-switch status reconciliation. Imports only types from the server lib.
import type { CalendarStatus } from "../lib/admin-calendar-api";

export const TIMEOUT_MESSAGE = "คำขอใช้เวลานานเกินไปหรือถูกตัดการเชื่อมต่อ ตรวจสถานะแล้วกดสลับอีกครั้งเพื่อทำต่อ";
export const NETWORK_MESSAGE = "เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่";
export const UNKNOWN_MESSAGE = "ไม่ทราบผลการสลับ การสลับอาจยังทำงานอยู่ รอสักครู่แล้วกดโหลดสถานะใหม่";
export const STATUS_UNKNOWN_MESSAGE = "อ่านสถานะล่าสุดไม่สำเร็จ การสลับอาจยังทำงานอยู่ กดโหลดสถานะใหม่ก่อนทำรายการต่อ";
export const LOCKED_NOW_MESSAGE = "ระบบยังล็อกอยู่ การสลับอาจยังทำงานอยู่ รอสักครู่แล้วกดโหลดสถานะใหม่ ถ้าค้างนานให้ปลดล็อก";
export const RESUME_HINT = "กดสลับอีกครั้งเพื่อคัดลอกต่อ";
export const FRESH_LOCK_MS = 60_000;

export type ApiResult = { status: number; ok: boolean; nonJson: boolean; body: Record<string, unknown> | null };

// response.json() throws on a platform 502/504 page or an empty body: that is reported as nonJson, never thrown.
export async function readApiResponse(response: Pick<Response, "status" | "ok" | "json">): Promise<ApiResult> {
  let body: unknown = null;
  let parsed = true;
  try {
    body = await response.json();
  } catch {
    parsed = false;
  }
  const isObject = parsed && typeof body === "object" && body !== null && !Array.isArray(body);
  return { status: response.status, ok: response.ok, nonJson: !isObject, body: isObject ? (body as Record<string, unknown>) : null };
}

export function parseApiError(result: ApiResult): string {
  const error = result.body?.error;
  if (typeof error === "string" && error) return error;
  if (result.nonJson && result.status >= 500) return TIMEOUT_MESSAGE;
  if (result.status === 401) return "กรุณาเข้าสู่ระบบใหม่อีกครั้ง";
  if (result.status === 403) return "เฉพาะผู้ดูแลระบบเท่านั้น";
  if (result.nonJson) return TIMEOUT_MESSAGE;
  return "ทำรายการไม่สำเร็จ กรุณาลองใหม่";
}

export type SwitchOutcome = {
  kind: "success" | "switched-with-error" | "error" | "unknown";
  text: string;
  // A copy step that stopped before finishing and can simply be pressed again.
  resumable: boolean;
  hint?: string;
  // Always re-read the status afterwards when the outcome may not match what the screen believes.
  reload: boolean;
};

const RESUMABLE_PATTERN = /กดเปลี่ยนอีกครั้ง/;

export function describeSwitchOutcome(result: ApiResult): SwitchOutcome {
  const body = result.body;
  if (result.nonJson) return { kind: "unknown", text: TIMEOUT_MESSAGE, resumable: false, reload: true };
  // fetch threw (status 0): the request may still be running on the server.
  if (result.status === 0) return { kind: "unknown", text: UNKNOWN_MESSAGE, resumable: false, reload: true };
  if (result.ok && body?.mode === "copy") {
    const copied = typeof body.copied === "number" ? body.copied : 0;
    return { kind: "success", text: `เปลี่ยนปฏิทินหลักแล้ว คัดลอก ${copied} รายการ`, resumable: false, reload: true };
  }
  if (result.ok && body?.mode === "token") {
    return { kind: "success", text: "ต่ออายุ token ของปฏิทินหลักแล้ว (ไม่ได้คัดลอกข้อมูล)", resumable: false, reload: true };
  }
  if (result.ok) return { kind: "unknown", text: TIMEOUT_MESSAGE, resumable: false, reload: true };
  const text = parseApiError(result);
  // The server could not tell whether the flip landed (no `switched` field), or says so outright.
  if (/ไม่ทราบผลการเปลี่ยนปฏิทินหลัก/.test(text) || (body?.step === "flip" && typeof body?.switched !== "boolean")) {
    return { kind: "unknown", text: UNKNOWN_MESSAGE, resumable: false, reload: true };
  }
  if (body?.switched === true) return { kind: "switched-with-error", text, resumable: false, reload: true };
  const resumable = body?.step === "copy" && RESUMABLE_PATTERN.test(text);
  return { kind: "error", text, resumable, hint: resumable ? RESUME_HINT : undefined, reload: true };
}

type Pub = { email: string; calendarId: string };
const same = (a: Pub, b: Pub) => a.email.trim().toLowerCase() === b.email.trim().toLowerCase() && a.calendarId.trim().toLowerCase() === b.calendarId.trim().toLowerCase();

// After a switch call whose answer is unreliable (timeout, non-JSON): what does the reloaded status say?
export function reconcileAfterSwitch(former: Pub, status: CalendarStatus | null): "switched" | "locked" | "not-switched" | "unknown" {
  if (!status) return "unknown";
  if (status.master.source === "settings" && same(status.master, former)) return "switched";
  if (status.locked) return "locked";
  return "not-switched";
}

// Clearing a lock younger than a minute may cut a running switch short. An unknown age is treated as fresh.
export function isFreshLock(status: Pick<CalendarStatus, "locked" | "lockedSince">, now: number): boolean {
  if (!status.locked) return false;
  if (typeof status.lockedSince !== "number") return true;
  return now - status.lockedSince < FRESH_LOCK_MS;
}

export function isStatus(value: unknown): value is CalendarStatus {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { master?: unknown; locked?: unknown };
  return typeof v.master === "object" && v.master !== null && typeof v.locked === "boolean";
}

export type SwitchNotice = { type: "success" | "error"; text: string; hint?: string };

const samePub = same;

// What to show and whether the preview survives, from the switch answer and the RELOADED status.
// A switch or token renewal LANDED only when the candidate is gone or replaced: both success paths remove it
// server-side. "Master equals candidate" proves nothing (token-only renewal starts in that state), and a definite
// error is never success. A live lock is checked first so it is never hidden.
export function decideAfterSwitch(outcome: SwitchOutcome, fresh: CalendarStatus | null, former: Pub): { notice: SwitchNotice; keepPreview: boolean } {
  if (!fresh) return { notice: { type: "error", text: STATUS_UNKNOWN_MESSAGE }, keepPreview: true };
  const candidateUnchanged = !!fresh.candidate && samePub(fresh.candidate, former);
  // A changed candidate alone is not proof: an unknown outcome also needs the master (or previous master) to be ours.
  const landed =
    !candidateUnchanged &&
    (outcome.kind === "success" ||
      outcome.kind === "switched-with-error" ||
      samePub(fresh.master, former) ||
      (!!fresh.previousMaster && samePub(fresh.previousMaster, former)));
  if (fresh.locked) {
    if (outcome.kind === "success" && landed) {
      return { notice: { type: "success", text: `${outcome.text} (ระบบยังล็อกอยู่ชั่วครู่หลังสลับ)` }, keepPreview: false };
    }
    return { notice: { type: "error", text: LOCKED_NOW_MESSAGE }, keepPreview: candidateUnchanged };
  }
  if (outcome.kind !== "error" && landed) {
    const text = outcome.kind === "success"
      ? outcome.text
      : "เปลี่ยนปฏิทินหลักเรียบร้อยแล้ว (ตรวจจากสถานะล่าสุด) ห้ามแก้ไขใน Google Calendar โดยตรง แก้ผ่านแอปเท่านั้น";
    return { notice: { type: "success", text }, keepPreview: false };
  }
  const text = outcome.kind === "unknown" ? `${outcome.text} (สถานะล่าสุด: ยังไม่ได้เปลี่ยนปฏิทิน)` : outcome.text;
  const hint = outcome.kind === "unknown" ? "กดสลับอีกครั้งเพื่อทำต่อ" : outcome.hint;
  return { notice: { type: "error", text, hint: candidateUnchanged ? hint : undefined }, keepPreview: candidateUnchanged };
}

// Why the previewed switch must not run (the server refuses the same cases before taking the lock), or null.
// - targetConflicts: the target holds app events the current master no longer has (cancelled or deleted since
//   they were copied there, typically the OLD master on a switch back); switching would bring them back.
// - invalidIds: source events Google will not accept with the same id.
export function switchBlockReason(preview: unknown): string | null {
  if (typeof preview !== "object" || preview === null) return null;
  const p = preview as { tokenOnly?: unknown; targetConflicts?: unknown; invalidIds?: unknown };
  if (p.tokenOnly === true) return null;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const reasons: string[] = [];
  const conflicts = count(p.targetConflicts);
  if (conflicts) {
    reasons.push(
      `ห้ามสลับไปปฏิทินนี้: ปฏิทินปลายทางมี ${conflicts} รายการของแอปที่ปฏิทินหลักปัจจุบันไม่มีแล้ว (ถูกยกเลิกหรือลบไปหลังจากเคยคัดลอกไว้) ถ้าสลับไป รายการเหล่านั้นจะกลับมาในแอป วิธีที่ปลอดภัย: สร้างปฏิทินใหม่ที่ว่าง แล้วเชื่อมต่อและสลับไปปฏิทินนั้นแทน`,
    );
  }
  const ids = count(p.invalidIds);
  if (ids) {
    reasons.push(
      `สลับไม่ได้: ปฏิทินหลักปัจจุบันมี ${ids} รายการที่รหัส event ไม่อยู่ในรูปแบบที่ Google ยอมให้คัดลอกด้วยรหัสเดิม (มักเป็นรายการที่นำเข้าจากโปรแกรมอื่น) ให้หยุดตรงนี้ ห้ามแก้ไขหรือลบรายการใด ๆ ใน Google Calendar (จะทำให้ข้อมูลการจองหาย) และติดต่อผู้พัฒนา การสลับจะยังถูกบล็อกจนกว่าผู้พัฒนาจะแก้ให้`,
    );
  }
  return reasons.length ? reasons.join(" ") : null;
}

// The switch button is usable only with a candidate, a preview of it that shows no blocker, and no lock.
export function canSwitchNow(status: CalendarStatus | null, preview: unknown): boolean {
  return !!status?.candidate && !!preview && !status.locked && switchBlockReason(preview) === null;
}
