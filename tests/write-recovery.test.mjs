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
  assert.match(g, /throw writeDeadlineError\(\)/);
  assert.doesNotMatch(g, /abandoned unsent/);
});
