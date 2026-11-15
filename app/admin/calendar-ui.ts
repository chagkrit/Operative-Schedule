// Pure helpers for the Admin master-calendar screen (no React, no network): response parsing, the fixed
// Thai outcome texts, and the post-switch status reconciliation. Imports only types from the server lib.
import type { CalendarStatus } from "../lib/admin-calendar-api";

export const TIMEOUT_MESSAGE = "คำขอใช้เวลานานเกินไปหรือถูกตัดการเชื่อมต่อ ตรวจสถานะแล้วกดสลับอีกครั้งเพื่อทำต่อ";
export const NETWORK_MESSAGE = "เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่";
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
  if (result.ok && body?.mode === "copy") {
    const copied = typeof body.copied === "number" ? body.copied : 0;
    return { kind: "success", text: `เปลี่ยนปฏิทินหลักแล้ว คัดลอก ${copied} รายการ`, resumable: false, reload: true };
  }
  if (result.ok && body?.mode === "token") {
    return { kind: "success", text: "ต่ออายุ token ของปฏิทินหลักแล้ว (ไม่ได้คัดลอกข้อมูล)", resumable: false, reload: true };
  }
  if (result.ok) return { kind: "unknown", text: TIMEOUT_MESSAGE, resumable: false, reload: true };
  const text = parseApiError(result);
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
