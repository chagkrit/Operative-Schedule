// SERVER-ONLY: recovery for a Calendar create whose request hit the app's write deadline.
// Aborting a request that was already sent does NOT stop Google from committing it, so a create with a
// client-chosen id is looked up before the user is told it failed (a blind retry would book twice).
// Pure: the lookup is injected; messages are fixed Thai text (no Google error text, no patient data).
export const WRITE_DEADLINE_MESSAGE = "บันทึกไปยัง Google Calendar ใช้เวลานานเกินไป กรุณาตรวจสอบข้อมูลแล้วลองใหม่";
export const POSSIBLY_SAVED_MESSAGE = "อาจบันทึกแล้ว กรุณาโหลดตารางใหม่ก่อนลองอีกครั้ง";
// Short timeout for the follow-up lookup GET.
export const RECOVERY_LOOKUP_TIMEOUT_MS = 8_000;

export function writeDeadlineError(): Error & { status: number; writeDeadline: true } {
  return Object.assign(new Error(WRITE_DEADLINE_MESSAGE), { status: 504, writeDeadline: true as const });
}

export function isWriteDeadlineError(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { writeDeadline?: unknown }).writeDeadline === true;
}

// lookup: GET of the event the create used (throws { status } on a non-ok answer, like googleFetch).
// Found (and not cancelled) => resolves: the create did commit. 404/410 or cancelled => rethrows the original
// deadline error. Lookup failed => "may already be saved" (504) so the user reloads instead of retrying.
export async function resolveAbortedCreate(original: unknown, lookup: () => Promise<Response>): Promise<void> {
  let response: Response;
  try {
    response = await lookup();
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status;
    if (status === 404 || status === 410) throw original;
    throw Object.assign(new Error(POSSIBLY_SAVED_MESSAGE), { status: 504 });
  }
  const event = (await response.json().catch(() => null)) as { status?: unknown } | null;
  if (!event) throw Object.assign(new Error(POSSIBLY_SAVED_MESSAGE), { status: 504 });
  if (event.status === "cancelled") throw original;
}

// Sends one Calendar request. With `sendBy` (writes), the request must get its response HEADERS by that
// instant, else it is aborted and a flagged write-deadline error is thrown (an instant already past sends
// nothing). The abort timer is armed right before sending and cleared as soon as headers arrive, so reading
// the response body is never aborted (Google has already committed the write by then). Without `sendBy`
// (reads), init and its own signal pass through untouched.
export async function sendWithDeadline(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  sendBy: number | undefined,
  now: () => number = Date.now,
): Promise<Response> {
  if (sendBy === undefined) return doFetch(url, init);
  const remaining = sendBy - now();
  if (remaining <= 0) throw writeDeadlineError();
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    return await doFetch(url, { ...init, signal });
  } catch (error) {
    if (controller.signal.aborted) throw writeDeadlineError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
