// A booking create whose POST hit the write deadline may still have been committed by Google.
// resolveAbortedCreate looks the client-chosen id up before deciding. Fetch fakes only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "./ts-resolve.mjs";

const wr = await import("../app/lib/write-recovery.ts");

const deadlineError = () => wr.writeDeadlineError();
// a lookup built on a fetch fake, the way calendar.ts builds it on googleFetch (which throws on !ok)
const lookupVia = (fetchFake) => async () => {
  const response = await fetchFake("https://www.googleapis.com/calendar/v3/calendars/c/events/oq123");
  if (!response.ok) throw Object.assign(new Error("SYNTH google text"), { status: response.status });
  return response;
};

test("deadline error is recognised (and only it)", () => {
  assert.equal(wr.isWriteDeadlineError(deadlineError()), true);
  assert.equal(deadlineError().status, 504);
  assert.equal(wr.isWriteDeadlineError(Object.assign(new Error("x"), { status: 409 })), false);
  assert.equal(wr.isWriteDeadlineError(new Error("network")), false);
});

test("aborted POST + GET finds the event ⇒ success", async () => {
  const seen = [];
  const fake = async (url) => { seen.push(url); return Response.json({ id: "oq123", status: "confirmed" }); };
  await wr.resolveAbortedCreate(deadlineError(), lookupVia(fake));
  assert.equal(seen.length, 1);
});

test("aborted POST + GET 404 (or 410) ⇒ the original error", async () => {
  for (const status of [404, 410]) {
    const original = deadlineError();
    const fake = async () => new Response("{}", { status });
    await assert.rejects(() => wr.resolveAbortedCreate(original, lookupVia(fake)), (err) => err === original);
  }
  // a found-but-cancelled event counts as not created
  const original = deadlineError();
  const cancelled = async () => Response.json({ id: "oq123", status: "cancelled" });
  await assert.rejects(() => wr.resolveAbortedCreate(original, lookupVia(cancelled)), (err) => err === original);
});

test("aborted POST + GET fails ⇒ 'may already be saved' (504), no Google text", async () => {
  for (const fake of [async () => new Response("{}", { status: 500 }), async () => { throw new Error("SYNTH network down"); }]) {
    await assert.rejects(() => wr.resolveAbortedCreate(deadlineError(), lookupVia(fake)), (err) => {
      assert.equal(err.message, wr.POSSIBLY_SAVED_MESSAGE);
      assert.equal(err.status, 504);
      assert.ok(!err.message.includes("SYNTH"));
      return true;
    });
  }
  assert.equal(wr.POSSIBLY_SAVED_MESSAGE, "อาจบันทึกแล้ว กรุณาโหลดตารางใหม่ก่อนลองอีกครั้ง");
});

test("calendar.ts: createBookingEvent recovers a deadline error by GETting its own id with a short timeout; googleFetch marks the deadline error", async () => {
  const src = await readFile(new URL("../app/lib/calendar.ts", import.meta.url), "utf8");
  const start = src.indexOf("export async function createBookingEvent(");
  const fn = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(fn, /isWriteDeadlineError\(error\)/);
  assert.match(fn, /resolveAbortedCreate\(error, \(\) =>\s*googleFetch\(request, `\/calendars\/@master\/events\/\$\{encodeURIComponent\(id\)\}`, \{ signal: AbortSignal\.timeout\(/);
  assert.ok(fn.indexOf("isWriteDeadlineError(error)") < fn.indexOf("status === 409"));
  const g = src.slice(src.indexOf("async function googleFetch("), src.indexOf("\n}\n", src.indexOf("async function googleFetch(")));
  // the flagged deadline error now comes from sendWithDeadline (write-recovery.ts), which googleFetch uses
  assert.match(g, /sendWithDeadline\(/);
  const helper = await readFile(new URL("../app/lib/write-recovery.ts", import.meta.url), "utf8");
  assert.match(helper, /throw writeDeadlineError\(\)/);
  assert.doesNotMatch(g, /abandoned unsent/);
});

// ---- sendWithDeadline: the write deadline covers SENDING only (until response headers) -------------
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A fetch fake that honours init.signal like undici: aborting before headers rejects the fetch; aborting
// after headers errors the body stream. Headers arrive after `headersMs`, the body after `bodyMs` more.
function slowFetch({ headersMs = 0, bodyMs = 0, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    const signal = init?.signal;
    const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, headersMs);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(abortError()); }, { once: true });
      if (signal?.aborted) { clearTimeout(timer); reject(abortError()); }
    });
    const body = new ReadableStream({
      start(controller) {
        const timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode('{"id":"ab01cd23","etag":"\\"1\\""}')); controller.close(); }, bodyMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); controller.error(abortError()); }, { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("sendWithDeadline: headers before the deadline, slow body after it ⇒ the body read is NOT aborted", async () => {
  const response = await wr.sendWithDeadline(slowFetch({ headersMs: 5, bodyMs: 80 }), "https://x.invalid/e", { method: "POST", body: "{}" }, Date.now() + 25);
  await delay(40); // well past the deadline
  assert.deepEqual(await response.json(), { id: "ab01cd23", etag: '"1"' });
});

test("sendWithDeadline: headers after the deadline ⇒ aborted with the flagged write-deadline error", async () => {
  await assert.rejects(
    wr.sendWithDeadline(slowFetch({ headersMs: 200 }), "https://x.invalid/e", { method: "POST", body: "{}" }, Date.now() + 20),
    (err) => wr.isWriteDeadlineError(err) && err.status === 504 && err.message === wr.WRITE_DEADLINE_MESSAGE,
  );
});

test("sendWithDeadline: a send-by instant already past ⇒ nothing is sent, flagged error", async () => {
  const calls = [];
  await assert.rejects(
    wr.sendWithDeadline(slowFetch({ calls }), "https://x.invalid/e", { method: "POST", body: "{}" }, Date.now() - 1),
    (err) => wr.isWriteDeadlineError(err),
  );
  assert.equal(calls.length, 0);
});

test("sendWithDeadline: no send-by (GET) passes init and its own signal through untouched", async () => {
  const calls = [];
  const own = AbortSignal.timeout(8_000);
  const response = await wr.sendWithDeadline(slowFetch({ calls }), "https://x.invalid/e", { method: "GET", signal: own }, undefined);
  assert.equal(response.status, 200);
  assert.equal(calls[0].init.signal, own);
});

test("sendWithDeadline: other fetch failures propagate unchanged (not flagged as a deadline)", async () => {
  const boom = Object.assign(new Error("SYNTH network down"), { status: 502 });
  await assert.rejects(
    wr.sendWithDeadline(async () => { throw boom; }, "https://x.invalid/e", { method: "PATCH" }, Date.now() + 1_000),
    (err) => err === boom,
  );
});

test("calendar.ts: googleFetch sends through sendWithDeadline with the send-by fixed before the lock check", async () => {
  const src = await readFile(new URL("../app/lib/calendar.ts", import.meta.url), "utf8");
  const g = src.slice(src.indexOf("async function googleFetch("), src.indexOf("\n}\n", src.indexOf("async function googleFetch(")));
  assert.match(g, /sendWithDeadline\(fetch, `https:\/\/www\.googleapis\.com\/calendar\/v3\$\{resolvedPath\}`/);
  assert.match(g, /sendBy\)/);
});
