// Copy engine for the Admin master-calendar switch. In-memory fakes only: no network, no Blob,
// synthetic events (no patient data).
import assert from "node:assert/strict";
import test from "node:test";
import "./ts-resolve.mjs";

const sw = await import("../app/lib/calendar-switch.ts");
const { createCalendarSettingsStore } = await import("../app/lib/calendar-settings-store.ts");

const ADMIN = "admin@example.com";
const t = (n, token = `v1.${n}.x.y`) => ({ email: `${n}@example.com`, calendarId: `cal-${n}`, sealedRefreshToken: token });

// ---- synthetic fixtures (one of each kind the app reads, plus events it skips) ----
const BOOKING = {
  id: "bk0001aa",
  status: "confirmed",
  summary: "OR17 • SYNTH booking",
  description: "SYNTH description\nline 2",
  location: "OR 17",
  colorId: "5",
  start: { dateTime: "2026-12-01T08:00:00+07:00", timeZone: "Asia/Bangkok" },
  end: { dateTime: "2026-12-01T09:00:00+07:00", timeZone: "Asia/Bangkok" },
  reminders: { useDefault: false, overrides: [] },
  extendedProperties: { private: { or_queue: "booking", queue_type: "OR17", slot_no: "1", hn: "SYNTH-HN-1", note: "a \"quoted\" note" } },
  created: "2026-01-01T00:00:00.000Z",
  updated: "2026-01-02T00:00:00.000Z",
  etag: "\"111\"",
  htmlLink: "https://example.invalid/e1",
  attendees: [{ email: "someone@example.com" }],
  organizer: { email: "org@example.com" },
};
const EXTRA = { id: "ex0001aa", summary: "SYNTH extra", start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day", note: "" } } };
const CLOSURE = { id: "cl0001aa", summary: "ปิดรับคิว • SYNTH", start: { date: "2027-01-05" }, end: { date: "2027-01-06" }, extendedProperties: { private: { or_queue: "schedule_closure", name: "SYNTH" } } };
const UNAVAIL = { id: "su0001aa", summary: "SYNTH leave", start: { date: "2027-01-06" }, end: { date: "2027-01-08" }, extendedProperties: { private: { or_queue: "staff_unavailable", staff: "SYNTH" } } };
// Untagged legacy event the app's legacy parser accepts (Thursday, 7-digit synthetic number).
const LEGACY = { id: "lg0001aa", summary: "A ทดสอบ 1234567 SYNTH-op", description: "  keep   spacing  ", start: { date: "2026-12-03" }, end: { date: "2026-12-04" }, colorId: "2", created: "2025-05-05T00:00:00Z" };
// Untagged events the app skips.
const PERSONAL = { id: "pe0001aa", summary: "Lunch", start: { date: "2026-12-03" }, end: { date: "2026-12-04" } };
const UNKNOWN_TAG = { id: "uk0001aa", summary: "x", start: { date: "2026-12-03" }, end: { date: "2026-12-04" }, extendedProperties: { private: { or_queue: "something_else" } } };
const CANCELLED_INSTANCE = { id: "rc0001aa_20261203", status: "cancelled", recurringEventId: "rc0001aa", originalStartTime: { date: "2026-12-03" } };

const ALL = () => structuredClone([BOOKING, EXTRA, CLOSURE, UNAVAIL, LEGACY, PERSONAL, UNKNOWN_TAG, CANCELLED_INSTANCE]);
const PLAN_IDS = [BOOKING.id, EXTRA.id, CLOSURE.id, UNAVAIL.id, LEGACY.id];

// ---- planCopy -------------------------------------------------------------------
test("planCopy keeps tagged events of each type and legacy events the parser accepts; counts the rest as skipped", () => {
  const plan = sw.planCopy(ALL());
  assert.deepEqual(plan.copy.map((e) => e.id).sort(), [...PLAN_IDS].sort());
  assert.deepEqual(plan.counts, { booking: 1, extra_day: 1, schedule_closure: 1, staff_unavailable: 1, legacy: 1 });
  assert.equal(plan.skipped, 3);
  assert.deepEqual(plan.byMonth, { "2026-12": 3, "2027-01": 2 });
});

const withoutOrig = (p) => Object.fromEntries(Object.entries(p || {}).filter(([k]) => k !== "orig_created" && k !== "orig_updated"));

test("planCopy copy preserves ids, extendedProperties.private and content byte-for-byte (+ orig_created/orig_updated); drops server/attendee fields", () => {
  const plan = sw.planCopy(ALL());
  const byId = new Map(plan.copy.map((e) => [e.id, e]));
  const b = byId.get(BOOKING.id);
  assert.equal(JSON.stringify(withoutOrig(b.extendedProperties.private)), JSON.stringify(BOOKING.extendedProperties.private));
  assert.equal(b.extendedProperties.private.orig_created, BOOKING.created);
  assert.equal(b.extendedProperties.private.orig_updated, BOOKING.updated);
  for (const k of ["id", "status", "summary", "description", "location", "colorId", "start", "end", "reminders"]) {
    assert.equal(JSON.stringify(b[k]), JSON.stringify(BOOKING[k]), k);
  }
  for (const k of ["created", "updated", "etag", "htmlLink", "attendees", "organizer"]) assert.ok(!(k in b), `${k} must not be copied`);
  const l = byId.get(LEGACY.id);
  assert.equal(JSON.stringify(l), JSON.stringify({ id: LEGACY.id, summary: LEGACY.summary, description: LEGACY.description, colorId: LEGACY.colorId, start: LEGACY.start, end: LEGACY.end, extendedProperties: { private: { orig_created: LEGACY.created } } }));
  assert.equal(l.extendedProperties.private.or_queue, undefined); // a legacy event stays untagged in the copy
  assert.equal(sw.classifyEvent(l), "legacy");
  // pure: the input is not modified
  const input = ALL();
  sw.planCopy(input);
  assert.deepEqual(input, ALL());
});

test("planCopy keeps orig_created/orig_updated a source event already carries (switching back keeps the first date)", () => {
  const already = { ...structuredClone(EXTRA), created: "2026-11-20T00:00:00Z", updated: "2026-11-21T00:00:00Z" };
  already.extendedProperties.private.orig_created = "2024-01-01T00:00:00Z";
  already.extendedProperties.private.orig_updated = "2024-02-02T00:00:00Z";
  const [copy] = sw.planCopy([already]).copy;
  assert.equal(copy.extendedProperties.private.orig_created, "2024-01-01T00:00:00Z");
  assert.equal(copy.extendedProperties.private.orig_updated, "2024-02-02T00:00:00Z");
});

test("countRecurring counts recurring masters and exception instances", () => {
  const master = { ...structuredClone(LEGACY), id: "rm0001aa", recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"] };
  assert.equal(sw.countRecurring([master, CANCELLED_INSTANCE, BOOKING, LEGACY]), 2);
});

test("planCopy carries a recurring master's recurrence and skips exception instances", () => {
  const master = { ...structuredClone(LEGACY), id: "rm0001aa", recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"] };
  const exception = { ...structuredClone(LEGACY), id: "rm0001aa_20261210", recurringEventId: "rm0001aa" };
  const plan = sw.planCopy([master, exception]);
  assert.deepEqual(plan.copy.map((e) => e.id), ["rm0001aa"]);
  assert.deepEqual(plan.copy[0].recurrence, master.recurrence);
  assert.equal(plan.skipped, 1);
});

// ---- fakes ----------------------------------------------------------------------
function fakeCalendar(name, log, events = []) {
  const c = {
    events: new Map(events.map((e) => [e.id, structuredClone(e)])),
    listCalls: 0,
    upserts: [],
    failOnUpsert: null,
    failList: null,
    onList: null,
    async listEvents() {
      c.listCalls += 1;
      log.push(`${name}.list`);
      if (c.onList) c.onList(c.listCalls, c);
      if (c.failList && c.failList(c.listCalls)) throw new Error(`SYNTH google list failed token=${name}-SECRET`);
      return [...c.events.values()].map((e) => structuredClone(e));
    },
    async upsertEvent(e) {
      const n = c.upserts.length + 1;
      log.push(`${name}.upsert`);
      if (c.failOnUpsert === n) {
        c.upserts.push({ id: e.id, result: "error" });
        throw new Error(`SYNTH google insert failed token=${name}-SECRET`);
      }
      const result = c.events.has(e.id) ? "updated" : "created";
      c.events.set(e.id, structuredClone(e));
      c.upserts.push({ id: e.id, result });
      return result;
    },
  };
  return c;
}

function memoryStore(initial, log) {
  const st = { data: structuredClone(initial), writes: [], removes: 0, failWriteWhen: null, landThenThrowWhen: null, failReads: 0, lateCommitWhen: null, pendingCommit: null, onWrite: null };
  const storage = {
    async read() {
      if (st.failReads > 0) {
        st.failReads -= 1;
        throw new Error("SYNTH blob read failed");
      }
      return st.data === "missing" ? "missing" : structuredClone(st.data);
    },
    async write(v) {
      if (st.onWrite) st.onWrite(v);
      if (st.failWriteWhen && st.failWriteWhen(v, st.writes.length + 1)) throw new Error("SYNTH blob write failed");
      // the real Blob failure mode: the 5 s abort fires first, the put commits a moment LATER
      // (applied by the harness during the settings settle sleep, i.e. after any immediate read-back)
      if (st.lateCommitWhen && st.lateCommitWhen(v)) {
        st.pendingCommit = structuredClone(v);
        throw new Error("SYNTH abort fired; put still in flight");
      }
      st.writes.push(structuredClone(v));
      log.push(v.lock ? "settings.write+lock" : "settings.write-nolock");
      st.data = structuredClone(v);
      // the put committed but the client saw an error (e.g. the 5 s abort fired after the blob landed)
      if (st.landThenThrowWhen && st.landThenThrowWhen(v, st)) throw new Error("SYNTH ambiguous timeout after landing");
    },
    async remove() {
      st.removes += 1;
      log.push("settings.remove");
      st.data = "missing";
    },
  };
  return { st, store: createCalendarSettingsStore(storage) };
}

const MASTER = t("old", "v1.OLDSEALED.x.y");
const CANDIDATE = t("new", "v1.NEWSEALED.x.y");

function harness({ settings = { master: MASTER, candidate: CANDIDATE }, sourceEvents = ALL(), targetEvents = [], envMaster, master = settings.master, advancing = false, copyBudgetMs, hardDeadlineMs = copyBudgetMs === undefined ? undefined : copyBudgetMs + 20_000 } = {}) {
  const log = [];
  const clock = { t: 5_000_000 };
  const sleeps = [];
  const mem = memoryStore(settings, log);
  const source = fakeCalendar("source", log, sourceEvents);
  const target = fakeCalendar("target", log, targetEvents);
  const deps = {
    settings: mem.store,
    source,
    target,
    by: ADMIN,
    // advancing: every now() call moves time on by 1 s (a fixed clock hides since-mismatch bugs)
    now: () => (advancing ? (clock.t += 1000) : clock.t),
    candidate: CANDIDATE,
    master,
    envMaster,
    sleep: async (ms) => {
      sleeps.push({ ms, at: clock.t, data: structuredClone(mem.st.data) });
      log.push(`sleep:${ms}`);
      clock.t += ms;
      if (mem.st.pendingCommit) {
        // the late put lands while the switch waits
        mem.st.writes.push(mem.st.pendingCommit);
        mem.st.data = mem.st.pendingCommit;
        mem.st.pendingCommit = null;
      }
    },
    copyBudgetMs,
    // tests that stretch the copy budget stretch the hard deadline with it
    hardDeadlineMs,
  };
  return { log, clock, sleeps, mem, source, target, deps };
}

const lockStates = (h) => h.mem.st.writes.map((w) => !!w.lock);

// ---- runSwitch --------------------------------------------------------------------
test("runSwitch success: target holds the same ids, master flipped, previousMaster = old, lock cleared", async () => {
  const h = harness();
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.copied, 5);
  assert.equal(r.created, 5);
  assert.equal(r.skipped, 3);
  assert.deepEqual(r.counts, { booking: 1, extra_day: 1, schedule_closure: 1, staff_unavailable: 1, legacy: 1 });
  assert.equal(r.lockCleared, true);
  assert.deepEqual([...h.target.events.keys()].sort(), [...PLAN_IDS].sort());
  assert.deepEqual(h.mem.st.data, { master: CANDIDATE, previousMaster: MASTER });
  // the source is never written
  assert.equal(h.source.upserts.length, 0);
  assert.ok(!h.log.some((l) => l.startsWith("source.") && l !== "source.list"));
});

test("lock is set before the first source read and cleared at the end; held >= 35 s after the flip", async () => {
  const h = harness();
  await sw.runSwitch(h.deps);
  assert.equal(h.log[0], "settings.write+lock");
  assert.ok(h.log.indexOf("settings.write+lock") < h.log.indexOf("source.list"));
  // flip write keeps the lock; the hold happens after it; then the lock is cleared
  const flipAt = h.mem.st.writes.findIndex((w) => w.master && w.master.calendarId === CANDIDATE.calendarId);
  assert.ok(flipAt > 0);
  assert.ok(h.mem.st.writes[flipAt].lock, "flip keeps the lock");
  const hold = h.sleeps.at(-1);
  assert.equal(h.sleeps.length, 2); // settle wait before the second source read, then the post-flip hold
  assert.ok(hold.ms >= 35_000);
  assert.equal(hold.data.master.calendarId, CANDIDATE.calendarId);
  assert.ok(hold.data.lock, "lock still active during the hold");
  assert.equal(sw.LOCK_HOLD_AFTER_FLIP_MS >= 35_000, true);
  const last = h.mem.st.writes.at(-1);
  assert.equal(last.lock, undefined);
  assert.ok(h.log.lastIndexOf("sleep:" + hold.ms) < h.log.lastIndexOf("settings.write-nolock"));
});

test("failure at copy (3rd upsert throws): master unchanged, lock cleared, step copy, fixed message without token", async () => {
  const h = harness();
  h.target.failOnUpsert = 3;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.step, "copy");
  assert.equal(r.error, sw.SWITCH_STEP_MESSAGES.copy);
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  assert.deepEqual(h.mem.st.data, { master: MASTER, candidate: CANDIDATE });
  assert.equal(lockStates(h)[0], true);
  assert.equal(lockStates(h).at(-1), false);
  assert.equal(h.sleeps.length, 0);

  // re-run completes with no duplicate ids; ids the first run already copied are skipped (unchanged)
  // (with 5 concurrent upserts, the ones already in flight when the 3rd failed also landed)
  const copiedFirst = new Set(h.target.events.keys());
  assert.ok(copiedFirst.size >= 2 && copiedFirst.size < 5);
  h.target.failOnUpsert = null;
  const before = h.target.upserts.length;
  const r2 = await sw.runSwitch(h.deps);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const second = h.target.upserts.slice(before);
  for (const u of second) assert.ok(!copiedFirst.has(u.id), `${u.id} already matched and must not be re-sent`);
  assert.equal(r2.unchanged, copiedFirst.size);
  assert.equal(r2.updated, 0);
  assert.equal(r2.created, 5 - copiedFirst.size);
  assert.equal(h.target.events.size, 5);
  assert.equal(new Set([...h.target.events.keys()]).size, 5);
  assert.deepEqual(h.mem.st.data, { master: CANDIDATE, previousMaster: MASTER });
});

test("an event added to the source between the first and second read is copied", async () => {
  const h = harness();
  const late = { id: "bk0002aa", start: { dateTime: "2026-12-15T08:00:00+07:00" }, end: { dateTime: "2026-12-15T09:00:00+07:00" }, extendedProperties: { private: { or_queue: "booking", queue_type: "EXTRA", slot_no: "2" } } };
  h.source.onList = (n, c) => {
    if (n === 2) c.events.set(late.id, structuredClone(late));
  };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(h.target.events.has(late.id));
  assert.equal(r.copied, 6);
  assert.equal(r.counts.booking, 2);
  assert.equal(h.source.listCalls, 3); // first read, second read, final confirmation read
});

test("an event changed in the source between reads is re-copied with the newer content", async () => {
  const h = harness();
  h.source.onList = (n, c) => {
    if (n === 2) c.events.get(EXTRA.id).extendedProperties.private.note = "changed";
  };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true);
  assert.equal(h.target.events.get(EXTRA.id).extendedProperties.private.note, "changed");
});

test("verify: a count mismatch in the target ⇒ step verify, no flip, lock cleared", async () => {
  const h = harness();
  // the target "loses" the tag of one copied event when read back
  const realList = h.target.listEvents;
  h.target.listEvents = async () => {
    const events = await realList();
    return events.map((e) => (e.id === EXTRA.id ? { ...e, extendedProperties: { private: { or_queue: "booking", queue_type: "OR17" } } } : e));
  };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.step, "verify");
  assert.equal(r.error, sw.SWITCH_STEP_MESSAGES.verify);
  assert.deepEqual(h.mem.st.data, { master: MASTER, candidate: CANDIDATE });
  assert.equal(lockStates(h).at(-1), false);
});

test("verify: an id missing from the target ⇒ step verify, no flip", async () => {
  const h = harness();
  const realList = h.target.listEvents;
  h.target.listEvents = async () => (await realList()).filter((e) => e.id !== LEGACY.id);
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "verify");
  assert.deepEqual(h.mem.st.data, { master: MASTER, candidate: CANDIDATE });
});

test("a target that already holds app events not in the source is refused before copying (step verify)", async () => {
  const stray = { id: "zz0001aa", start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day" } } };
  const h = harness({ targetEvents: [stray, PERSONAL] });
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "verify");
  assert.equal(h.target.upserts.length, 0);
  assert.deepEqual(h.mem.st.data, { master: MASTER, candidate: CANDIDATE });
  // a target holding only events the app ignores is fine
  const h2 = harness({ targetEvents: [PERSONAL] });
  assert.equal((await sw.runSwitch(h2.deps)).ok, true);
});

test("source read failure ⇒ step read, lock cleared, no flip", async () => {
  const h = harness();
  h.source.failList = (n) => n === 1;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "read");
  assert.equal(r.error, sw.SWITCH_STEP_MESSAGES.read);
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  assert.equal(lockStates(h).at(-1), false);
  assert.deepEqual(h.mem.st.data, { master: MASTER, candidate: CANDIDATE });
  // second read failing is also a read failure
  const h2 = harness();
  h2.source.failList = (n) => n === 2;
  assert.equal((await sw.runSwitch(h2.deps)).step, "read");
  assert.equal(lockStates(h2).at(-1), false);
});

test("lock step: refused while another lock is active (the other lock is left alone) or when the candidate changed", async () => {
  const other = { since: 5_000_000 - 1000, by: "other@example.com" };
  const h = harness({ settings: { master: MASTER, candidate: CANDIDATE, lock: other } });
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "lock");
  assert.deepEqual(h.mem.st.data.lock, other);
  assert.equal(h.source.listCalls, 0);

  const h2 = harness({ settings: { master: MASTER, candidate: t("someone-else") } });
  const r2 = await sw.runSwitch(h2.deps);
  assert.equal(r2.step, "lock");
  assert.equal(h2.mem.st.writes.length, 0);
  assert.equal(h2.source.listCalls, 0);
});

test("flip step: lock cleared by someone else mid-run ⇒ no flip, step flip", async () => {
  const h = harness();
  h.target.onList = () => {
    // an admin pressed clearLock while the copy was running
    delete h.mem.st.data.lock;
  };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "flip");
  assert.equal(h.mem.st.data.master.calendarId, MASTER.calendarId);
  assert.equal(h.mem.st.data.lock, undefined);
});

test("flip write failure ⇒ step flip, master unchanged, lock cleared", async () => {
  const h = harness();
  h.mem.st.failWriteWhen = (v) => v.master && v.master.calendarId === CANDIDATE.calendarId;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "flip");
  assert.equal(r.error, sw.SWITCH_STEP_MESSAGES.flip);
  assert.deepEqual(h.mem.st.data, { master: MASTER, candidate: CANDIDATE });
});

test("env mode: no master in the file ⇒ previousMaster is the env master after the flip", async () => {
  const env = t("env", "v1.ENVSEALED.x.y");
  const h = harness({ settings: { candidate: CANDIDATE }, envMaster: env, master: undefined });
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(h.mem.st.data, { master: CANDIDATE, previousMaster: env });
});

test("lock clear failing after the flip still reports ok with lockCleared false", async () => {
  const h = harness();
  h.mem.st.failWriteWhen = (v) => v.master && v.master.calendarId === CANDIDATE.calendarId && !v.lock;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true);
  assert.equal(r.lockCleared, false);
  assert.equal(h.mem.st.data.master.calendarId, CANDIDATE.calendarId);
});

test("a long copy renews the lock so it never expires mid-copy", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `ex${String(i).padStart(4, "0")}bb`, start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day" } } }));
  const h = harness({ sourceEvents: many, copyBudgetMs: 3 * 60 * 60_000 });
  const realUpsert = h.target.upsertEvent;
  h.target.upsertEvent = async (e) => {
    h.clock.t += 60_000; // one minute per event: 30 minutes total, longer than the 20 min lock TTL
    return realUpsert(e);
  };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  const lockSinces = new Set(h.mem.st.writes.filter((w) => w.lock).map((w) => w.lock.since));
  assert.ok(lockSinces.size >= 3, "lock renewed during the copy");
});

test("no failure path leaves the lock set (sweep over every step)", async () => {
  const setups = [
    (h) => { h.source.failList = () => true; },
    (h) => { h.target.failOnUpsert = 1; },
    (h) => { h.target.failList = () => true; },
    (h) => { h.mem.st.failWriteWhen = (v) => !!v.master && v.master.calendarId === CANDIDATE.calendarId; },
  ];
  for (const setup of setups) {
    const h = harness();
    setup(h);
    const r = await sw.runSwitch(h.deps);
    assert.equal(r.ok, false);
    assert.equal(h.mem.st.data.lock, undefined, `step ${r.step}`);
    assert.equal(h.mem.st.data.master.calendarId, MASTER.calendarId);
  }
});

// ---- token-only refresh (same email + calendar) --------------------------------------
test("isSameCalendar: normalized email + calendar id compared case-insensitively, \"primary\" = the owner's email", () => {
  assert.equal(sw.isSameCalendar({ email: "A@Example.com", calendarId: "c1" }, { email: "a@example.com", calendarId: "c1" }), true);
  assert.equal(sw.isSameCalendar({ email: "a@example.com", calendarId: "C1" }, { email: "a@example.com", calendarId: "c1" }), true);
  assert.equal(sw.isSameCalendar({ email: "b@example.com", calendarId: "c1" }, { email: "a@example.com", calendarId: "c1" }), false);
  assert.equal(sw.isSameCalendar({ email: "a@example.com", calendarId: "primary" }, { email: "a@example.com", calendarId: "A@example.com" }), true);
  assert.equal(sw.isSameCalendar({ email: "a@example.com", calendarId: "primary" }, { email: "a@example.com", calendarId: "other" }), false);
  // same calendar through another account: same id, not the same account
  assert.equal(sw.sameCalendarId({ email: "b@example.com", calendarId: "shared@group" }, { email: "a@example.com", calendarId: "Shared@Group" }), true);
  assert.equal(sw.isSameCalendar({ email: "b@example.com", calendarId: "shared@group" }, { email: "a@example.com", calendarId: "shared@group" }), false);
  assert.equal(sw.sameCalendarId({ email: "b@example.com", calendarId: "primary" }, { email: "a@example.com", calendarId: "primary" }), false);
});

test("runSwitch refuses (step lock, before any lock or Google call) when the candidate is the source calendar itself", async () => {
  const sameIdOtherAccount = { email: "other@example.com", calendarId: MASTER.calendarId.toUpperCase(), sealedRefreshToken: "v1.OTHER.x.y" };
  const h = harness({ settings: { master: MASTER, candidate: sameIdOtherAccount } });
  h.deps.candidate = sameIdOtherAccount;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.step, "lock");
  assert.equal(h.mem.st.writes.length, 0);
  assert.equal(h.source.listCalls + h.target.listCalls + h.target.upserts.length, 0);
  // env mode: candidate "primary" of the env account resolves to the env calendar
  const env = { email: "env@example.com", calendarId: "env@example.com", sealedRefreshToken: "v1.ENV.x.y" };
  const primary = { email: "env@example.com", calendarId: "primary", sealedRefreshToken: "v1.P.x.y" };
  const h2 = harness({ settings: { candidate: primary }, envMaster: env, master: undefined });
  h2.deps.candidate = primary;
  assert.equal((await sw.runSwitch(h2.deps)).step, "lock");
  assert.equal(h2.mem.st.writes.length + h2.source.listCalls, 0);
});

test("withRefreshedMasterToken: settings mode replaces only the sealed token, keeps previousMaster, drops candidate", () => {
  const same = { ...MASTER, sealedRefreshToken: "v1.RENEWED.x.y" };
  const r = sw.withRefreshedMasterToken({ master: MASTER, previousMaster: t("older"), candidate: same });
  assert.deepEqual(r, { master: same, previousMaster: t("older") });
  // env mode: the candidate becomes the settings master; previousMaster = env master
  const env = t("env");
  const cand = { ...env, sealedRefreshToken: "v1.RENEWED.x.y" };
  assert.deepEqual(sw.withRefreshedMasterToken({ candidate: cand }, env), { master: cand, previousMaster: env });
  assert.deepEqual(sw.withRefreshedMasterToken({ candidate: cand }), { master: cand });
  assert.throws(() => sw.withRefreshedMasterToken({ master: MASTER, candidate: CANDIDATE }));
  assert.throws(() => sw.withRefreshedMasterToken({ master: MASTER }));
});

// ---- production client (fake fetch only) ---------------------------------------------
function fakeGoogle(handler) {
  const seen = [];
  const fetchFn = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    if (String(url) === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "SYNTH-ACCESS", expires_in: 3600 });
    return handler(String(url), init, seen);
  };
  return { seen, fetchFn };
}

test("google client: lists with singleEvents=false, paginates to completion, sends the bearer token", async () => {
  const { seen, fetchFn } = fakeGoogle((url) => {
    const u = new URL(url);
    const page = u.searchParams.get("pageToken");
    if (!page) return Response.json({ items: [{ id: "a1" }], nextPageToken: "p2" });
    if (page === "p2") return Response.json({ items: [{ id: "a2" }], nextPageToken: "p3" });
    return Response.json({ items: [{ id: "a3" }] });
  });
  const client = sw.createGoogleCalendarClient({ calendarId: "cal x@group.calendar.google.com", refreshToken: "SYNTH-REFRESH" }, { fetch: fetchFn, clientId: "cid", clientSecret: "cs", sleep: async () => {} });
  const events = await client.listEvents();
  assert.deepEqual(events.map((e) => e.id), ["a1", "a2", "a3"]);
  const lists = seen.filter((s) => s.url.includes("/events"));
  assert.equal(lists.length, 3);
  for (const l of lists) {
    const u = new URL(l.url);
    assert.equal(u.pathname, "/calendar/v3/calendars/cal%20x%40group.calendar.google.com/events");
    assert.equal(u.searchParams.get("singleEvents"), "false");
    assert.equal(l.init.headers.authorization, "Bearer SYNTH-ACCESS");
  }
  // one token exchange for the whole run
  assert.equal(seen.filter((s) => s.url.includes("oauth2")).length, 1);
});

test("google client: a never-ending or repeating page token is bounded", async () => {
  const { fetchFn } = fakeGoogle(() => Response.json({ items: [], nextPageToken: "same" }));
  const client = sw.createGoogleCalendarClient({ calendarId: "c", refreshToken: "r" }, { fetch: fetchFn, clientId: "cid", clientSecret: "cs", sleep: async () => {} });
  await assert.rejects(() => client.listEvents());
  let n = 0;
  const { fetchFn: endless } = fakeGoogle(() => Response.json({ items: [], nextPageToken: `p${++n}` }));
  const client2 = sw.createGoogleCalendarClient({ calendarId: "c", refreshToken: "r" }, { fetch: endless, clientId: "cid", clientSecret: "cs", maxPages: 5, sleep: async () => {} });
  await assert.rejects(() => client2.listEvents());
  assert.ok(n <= 5);
});

test("google client: insert keeps the id with sendUpdates=none; 409 falls back to update (PUT)", async () => {
  const { seen, fetchFn } = fakeGoogle((url, init) => {
    if (init.method === "POST") return url.includes("dup") ? new Response("{}", { status: 409 }) : Response.json({ id: "x" });
    if (init.method === "PUT") return Response.json({ id: "dup" });
    return new Response("{}", { status: 500 });
  });
  const client = sw.createGoogleCalendarClient({ calendarId: "c1", refreshToken: "r" }, { fetch: fetchFn, clientId: "cid", clientSecret: "cs", sleep: async () => {} });
  const event = { id: "new0001", summary: "s", extendedProperties: { private: { or_queue: "booking" } } };
  assert.equal(await client.upsertEvent(event), "created");
  const post = seen.find((s) => s.init.method === "POST" && s.url.includes("/events"));
  assert.equal(new URL(post.url).searchParams.get("sendUpdates"), "none");
  assert.deepEqual(JSON.parse(post.init.body), event);
  // events.insert is a POST to /events (no id in the path); the id travels in the body
  assert.equal(new URL(post.url).pathname, "/calendar/v3/calendars/c1/events");

  // the fake answers 409 for any URL containing "dup"; use a calendar id that makes the POST conflict
  const client2 = sw.createGoogleCalendarClient({ calendarId: "dup-cal", refreshToken: "r" }, { fetch: fetchFn, clientId: "cid", clientSecret: "cs", sleep: async () => {} });
  assert.equal(await client2.upsertEvent({ id: "dup0001", summary: "s" }), "updated");
  const put = seen.find((s) => s.init.method === "PUT");
  assert.equal(new URL(put.url).pathname, "/calendar/v3/calendars/dup-cal/events/dup0001");
  assert.equal(new URL(put.url).searchParams.get("sendUpdates"), "none");
});

test("google client: errors carry no token and no Google error text", async () => {
  const { fetchFn } = fakeGoogle(() => Response.json({ error: { message: "SYNTH-GOOGLE-TEXT SYNTH-REFRESH" } }, { status: 400 }));
  const client = sw.createGoogleCalendarClient({ calendarId: "c", refreshToken: "SYNTH-REFRESH" }, { fetch: fetchFn, clientId: "cid", clientSecret: "cs", sleep: async () => {} });
  for (const op of [() => client.listEvents(), () => client.upsertEvent({ id: "abc0001" })]) {
    await assert.rejects(op, (err) => {
      assert.ok(!String(err.message).includes("SYNTH-REFRESH"));
      assert.ok(!String(err.message).includes("SYNTH-GOOGLE-TEXT"));
      assert.ok(!String(err.message).includes("SYNTH-ACCESS"));
      return true;
    });
  }
  // a failed token exchange also throws a fixed message
  const badToken = async () => Response.json({ error: "invalid_grant", error_description: "SYNTH-REFRESH bad" }, { status: 400 });
  const client2 = sw.createGoogleCalendarClient({ calendarId: "c", refreshToken: "SYNTH-REFRESH" }, { fetch: badToken, clientId: "cid", clientSecret: "cs", sleep: async () => {} });
  await assert.rejects(() => client2.listEvents(), (err) => !String(err.message).includes("SYNTH-REFRESH"));
});

test("google client: retries 429/5xx a few times with backoff, then gives up", async () => {
  let calls = 0;
  const { fetchFn } = fakeGoogle(() => {
    calls += 1;
    return calls < 3 ? new Response("{}", { status: 429 }) : Response.json({ items: [{ id: "ok1" }] });
  });
  const waits = [];
  const client = sw.createGoogleCalendarClient({ calendarId: "c", refreshToken: "r" }, { fetch: fetchFn, clientId: "cid", clientSecret: "cs", sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual((await client.listEvents()).map((e) => e.id), ["ok1"]);
  assert.equal(waits.length, 2);
  let n = 0;
  const { fetchFn: always503 } = fakeGoogle(() => { n += 1; return new Response("{}", { status: 503 }); });
  const client2 = sw.createGoogleCalendarClient({ calendarId: "c", refreshToken: "r" }, { fetch: always503, clientId: "cid", clientSecret: "cs", sleep: async () => {} });
  await assert.rejects(() => client2.listEvents());
  assert.ok(n <= 5);
});

// ---- fix round 1: ambiguous settings writes, late writes, concurrency, deeper verify ----------------
test("lock write lands but reports an error (advancing clock): the run recognises its own lock and completes", async () => {
  const h = harness({ advancing: true });
  let first = true;
  h.mem.st.landThenThrowWhen = (v) => {
    if (first && v.lock) { first = false; return true; }
    return false;
  };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(h.mem.st.data, { master: CANDIDATE, previousMaster: MASTER });
});

test("renew write lands but reports an error: the copy continues and the lock is still released", async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `ex${String(i).padStart(4, "0")}cc`, start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day" } } }));
  const h = harness({ sourceEvents: many, advancing: true, copyBudgetMs: 3 * 60 * 60_000 });
  const realUpsert = h.target.upsertEvent;
  h.target.upsertEvent = async (e) => { h.clock.t += 60_000; return realUpsert(e); };
  let lockWrites = 0;
  h.mem.st.landThenThrowWhen = (v) => !!v.lock && !v.master?.calendarId.includes("new") && ++lockWrites === 2; // the first renewal
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(h.mem.st.data.lock, undefined);
});

test("flip write lands but reports an error (advancing clock): reported as switched, lock released after the hold", async () => {
  const h = harness({ advancing: true });
  h.mem.st.landThenThrowWhen = (v) => v.master?.calendarId === CANDIDATE.calendarId && !!v.lock;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.lockCleared, true);
  assert.deepEqual(h.mem.st.data, { master: CANDIDATE, previousMaster: MASTER });
  assert.ok(h.sleeps.some((s) => s.ms >= 35_000 && s.data.master.calendarId === CANDIDATE.calendarId));
});

test("flip write lands, then the read-back fails: outcome reported as unknown, never 'not switched'", async () => {
  const h = harness({ advancing: true });
  h.mem.st.landThenThrowWhen = (v, st) => {
    if (v.master?.calendarId === CANDIDATE.calendarId && v.lock) { st.failReads = 1; return true; }
    return false;
  };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.step, "flip");
  assert.equal(r.error, sw.SWITCH_OUTCOME_UNKNOWN_MESSAGE);
  assert.ok(!r.error.includes("ยังไม่ได้เปลี่ยนปฏิทิน"));
  assert.equal(h.mem.st.data.master.calendarId, CANDIDATE.calendarId);
  assert.equal(h.mem.st.data.lock, undefined, "the release still clears our lock");
});

test("a write that lands in the source after the second read (during verify) aborts the switch", async () => {
  const h = harness({ advancing: true });
  const LATE = { id: "late0001", start: { date: "2026-12-14" }, end: { date: "2026-12-15" }, extendedProperties: { private: { or_queue: "extra_day" } } };
  h.target.onList = (n) => {
    if (n === 2) h.source.events.set(LATE.id, structuredClone(LATE));
  };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.step, "verify");
  assert.equal(h.mem.st.data.master.calendarId, MASTER.calendarId);
  assert.equal(h.mem.st.data.lock, undefined);
  assert.equal(h.source.listCalls, 3, "a final source read after verify");
});

test("the second source read waits until lock.since + SETTLE_MS (45 s)", async () => {
  assert.equal(sw.SETTLE_MS, 45_000);
  const h = harness({ advancing: true });
  const at = [];
  h.source.onList = () => at.push(h.clock.t);
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true);
  const lockSince = h.mem.st.writes[0].lock.since;
  assert.ok(at[1] >= lockSince + sw.SETTLE_MS, `second read at +${at[1] - lockSince} ms`);
  assert.ok(h.sleeps.some((s) => s.ms > 0 && s.ms <= sw.SETTLE_MS));
});

test("Calendar writes in the app are sent within a deadline (from the lock check) shorter than SETTLE_MS; reads unchanged", async () => {
  const { readFile } = await import("node:fs/promises");
  const { CALENDAR_WRITE_DEADLINE_MS } = await import("../app/lib/calendar-target.ts");
  assert.ok(CALENDAR_WRITE_DEADLINE_MS <= 30_000);
  assert.ok(CALENDAR_WRITE_DEADLINE_MS + 10_000 <= sw.SETTLE_MS);
  // the settings read of a write is bounded, so "send-by" fixed before it still leaves the margin
  const { BLOB_TIMEOUT_MS } = await import("../app/lib/calendar-settings-store.ts");
  assert.ok(BLOB_TIMEOUT_MS <= 5_000);
  const src = await readFile(new URL("../app/lib/calendar.ts", import.meta.url), "utf8");
  const block = (head) => {
    const start = src.indexOf(head);
    return src.slice(start, src.indexOf("\n}\n", start));
  };
  // The send-by instant of a write is fixed right BEFORE its lock-check read (so the switch's settle wait
  // still outlasts any write that passed the check); GET gets none.
  const auth = block("async function authorizedAccessToken(");
  assert.match(auth, /sendBy = method\.toUpperCase\(\) === "GET" \? undefined : Date\.now\(\) \+ CALENDAR_WRITE_DEADLINE_MS/);
  assert.ok(auth.indexOf("sendBy =") !== -1 && auth.indexOf("sendBy =") < auth.indexOf("resolveCalendarTarget("));
  // The abort covers sending only: armed after auth/settings/token work, cleared when headers arrive.
  const fn = block("async function googleFetch(");
  assert.ok(fn.indexOf("authorizedAccessToken(") < fn.indexOf("sendWithDeadline("));
  assert.doesNotMatch(fn, /AbortSignal\.timeout\(CALENDAR_WRITE_DEADLINE_MS\)/);
});

test("copy runs at most 5 upserts at once and verify starts only after all of them finished", async () => {
  const many = Array.from({ length: 23 }, (_, i) => ({ id: `ex${String(i).padStart(4, "0")}dd`, start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day" } } }));
  const h = harness({ sourceEvents: many });
  let inFlight = 0;
  let maxInFlight = 0;
  const realUpsert = h.target.upsertEvent;
  h.target.upsertEvent = async (e) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1 + (e.id.charCodeAt(5) % 3)));
    try { return await realUpsert(e); } finally { inFlight -= 1; }
  };
  const realList = h.target.listEvents;
  const inFlightAtList = [];
  h.target.listEvents = async () => { inFlightAtList.push(inFlight); return realList(); };
  const sourceList = h.source.listEvents;
  const inFlightAtSource = [];
  h.source.listEvents = async () => { inFlightAtSource.push(inFlight); return sourceList(); };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(maxInFlight, 5);
  assert.deepEqual(inFlightAtList, [0, 0]);
  assert.deepEqual(inFlightAtSource, [0, 0, 0]);
  assert.equal(h.target.events.size, 23);
});

test("lock renewal is serialized while 5 workers copy (never two renewals at once)", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `ex${String(i).padStart(4, "0")}ee`, start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day" } } }));
  const h = harness({ sourceEvents: many, copyBudgetMs: 3 * 60 * 60_000 });
  const realUpsert = h.target.upsertEvent;
  h.target.upsertEvent = async (e) => { h.clock.t += 60_000; await new Promise((r) => setTimeout(r, 1)); return realUpsert(e); };
  const realMutate = h.deps.settings.mutate.bind(h.deps.settings);
  let active = 0;
  let maxActive = 0;
  h.deps.settings = { ...h.deps.settings, read: h.deps.settings.read.bind(h.deps.settings), mutate: async (fn) => {
    active += 1; maxActive = Math.max(maxActive, active);
    try { return await realMutate(fn); } finally { active -= 1; }
  } };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(maxActive, 1);
});

test("verify compares each copied event's private props, start and end with the source", async () => {
  const h = harness();
  const realList = h.target.listEvents;
  let n = 0;
  h.target.listEvents = async () => {
    n += 1;
    const events = await realList();
    if (n < 2) return events;
    return events.map((e) => (e.id === BOOKING.id ? { ...e, extendedProperties: { private: { ...e.extendedProperties.private, slot_no: "9" } } } : e));
  };
  assert.equal((await sw.runSwitch(h.deps)).step, "verify");
  const h2 = harness();
  const real2 = h2.target.listEvents;
  let m = 0;
  h2.target.listEvents = async () => {
    m += 1;
    const events = await real2();
    return m < 2 ? events : events.map((e) => (e.id === EXTRA.id ? { ...e, end: { date: "2026-12-09" } } : e));
  };
  assert.equal((await sw.runSwitch(h2.deps)).step, "verify");
  assert.equal(h2.mem.st.data.master.calendarId, MASTER.calendarId);
});

test("verify accepts the same instant written in another time-zone offset and a different key order", async () => {
  const h = harness();
  const realList = h.target.listEvents;
  h.target.listEvents = async () => (await realList()).map((e) => {
    if (e.id !== BOOKING.id) return e;
    const priv = Object.fromEntries(Object.entries(e.extendedProperties.private).reverse());
    return { ...e, start: { timeZone: "Asia/Bangkok", dateTime: "2026-12-01T01:00:00Z" }, end: { timeZone: "Asia/Bangkok", dateTime: "2026-12-01T02:00:00Z" }, extendedProperties: { private: priv } };
  });
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
});

// ---- readers prefer orig_created / orig_updated (copied events keep their original dates) -------------
const legacyMod = await import("../app/lib/legacy-calendar.ts");

function asCopiedInTarget(source) {
  const [body] = sw.planCopy([source]).copy;
  return { ...body, created: "2026-11-20T03:00:00.000Z", updated: "2026-11-20T03:00:00.000Z" };
}

test("a copied legacy event keeps its queued date through the legacy parser", () => {
  const copied = asCopiedInTarget(LEGACY);
  const before = legacyMod.parseLegacyCalendarEvent(LEGACY);
  const after = legacyMod.parseLegacyCalendarEvent(copied);
  assert.equal(before.queuedDate, "2025-05-05");
  assert.deepEqual(after, before);
});

test("a copied tagged event keeps its created/updated timestamps through the reader helpers", () => {
  const closure = { ...structuredClone(CLOSURE), created: "2025-02-02T00:00:00Z", updated: "2025-03-03T00:00:00Z" };
  const copied = asCopiedInTarget(closure);
  assert.equal(legacyMod.eventCreated(copied), "2025-02-02T00:00:00Z");
  assert.equal(legacyMod.eventUpdated(copied), "2025-03-03T00:00:00Z");
  const booking = asCopiedInTarget(BOOKING); // no queued_date: the reader falls back to created
  assert.equal(legacyMod.calendarTimestampDate(legacyMod.eventCreated(booking)), legacyMod.calendarTimestampDate(BOOKING.created));
  // an edit made by the app after the switch clears orig_updated, so the edit time shows again
  const edited = { ...copied, updated: "2026-12-24T00:00:00Z", extendedProperties: { private: { ...copied.extendedProperties.private, orig_updated: "" } } };
  assert.equal(legacyMod.eventUpdated(edited), "2026-12-24T00:00:00Z");
  // events never copied read exactly as before
  assert.equal(legacyMod.eventCreated(closure), closure.created);
  assert.equal(legacyMod.eventUpdated(closure), closure.updated);
});

test("calendar.ts readers use the orig-aware helpers; closure/leave edits clear orig_updated", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../app/lib/calendar.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /event\.created|event\.updated/);
  assert.match(src, /queuedDate: data\.queued_date \|\| calendarTimestampDate\(eventCreated\(event\)\) \|\| date/);
  assert.equal((src.match(/updatedAt: eventUpdated\(event\) \|\| data\.created_at \|\| ""/g) || []).length, 2);
  assert.equal((src.match(/createdAt: data\.created_at \|\| eventCreated\(event\) \|\| eventUpdated\(event\) \|\| ""/g) || []).length, 2);
  for (const tag of ["schedule_closure", "staff_unavailable"]) {
    const at = src.indexOf(`or_queue: "${tag}",`);
    const privateBlock = src.slice(at, src.indexOf("} }", at));
    assert.match(privateBlock, /orig_updated: ""/, tag);
  }
});

// ---- fix round 2: late-committing settings writes, run budget, cheap re-runs -------------------------
const extras = (n, tag) => Array.from({ length: n }, (_, i) => ({ id: `ex${String(i).padStart(4, "0")}${tag}`, start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day" } } }));

test("SETTINGS_SETTLE_MS is exported (8 s) and COPY_PHASE_BUDGET_MS is 150 s", () => {
  assert.equal(sw.SETTINGS_SETTLE_MS, 8_000);
  assert.equal(sw.COPY_PHASE_BUDGET_MS, 150_000);
});

test("lock put that commits LATE (after the abort): the run waits SETTINGS_SETTLE_MS, sees its lock, completes", async () => {
  const h = harness({ advancing: true });
  let first = true;
  h.mem.st.lateCommitWhen = (v) => { if (first && v.lock) { first = false; return true; } return false; };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(h.sleeps[0].ms, sw.SETTINGS_SETTLE_MS);
  assert.deepEqual(h.mem.st.data, { master: CANDIDATE, previousMaster: MASTER });
});

test("lock put that never commits: after the settle re-read the run fails at lock, no lock left behind", async () => {
  const h = harness({ advancing: true });
  h.mem.st.failWriteWhen = (v, n) => n === 1 && !!v.lock;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "lock");
  assert.ok(h.sleeps.some((x) => x.ms === sw.SETTINGS_SETTLE_MS));
  assert.equal(h.mem.st.data.lock, undefined);
  assert.equal(h.source.listCalls, 0);
});

test("a refusal thrown by the mutate callback (already locked) is not a storage error: no settle wait", async () => {
  const other = { since: 5_000_000 - 1000, by: "other@example.com" };
  const h = harness({ settings: { master: MASTER, candidate: CANDIDATE, lock: other } });
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "lock");
  assert.equal(h.sleeps.length, 0);
  assert.deepEqual(h.mem.st.data.lock, other);
});

test("renewal put that commits LATE: the copy continues and the lock is released at the end", async () => {
  const h = harness({ sourceEvents: extras(12, "ff"), advancing: true, copyBudgetMs: 3 * 60 * 60_000 });
  const realUpsert = h.target.upsertEvent;
  h.target.upsertEvent = async (e) => { h.clock.t += 60_000; return realUpsert(e); };
  let lockWrites = 0;
  h.mem.st.lateCommitWhen = (v) => !!v.lock && v.master?.calendarId === MASTER.calendarId && ++lockWrites === 2; // first renewal
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(h.sleeps.some((x) => x.ms === sw.SETTINGS_SETTLE_MS));
  assert.equal(h.mem.st.data.lock, undefined);
  assert.equal(h.mem.st.data.master.calendarId, CANDIDATE.calendarId);
});

test("flip put that commits LATE: reported as switched (never 'not switched'), lock released after the hold", async () => {
  const h = harness({ advancing: true });
  h.mem.st.lateCommitWhen = (v) => v.master?.calendarId === CANDIDATE.calendarId && !!v.lock;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.lockCleared, true);
  assert.deepEqual(h.mem.st.data, { master: CANDIDATE, previousMaster: MASTER });
  const settleAt = h.sleeps.findIndex((x) => x.ms === sw.SETTINGS_SETTLE_MS);
  const holdAt = h.sleeps.findIndex((x) => x.ms === sw.LOCK_HOLD_AFTER_FLIP_MS);
  assert.ok(settleAt !== -1 && holdAt > settleAt);
});

test("SETTLE_MS is measured from when the lock write was CONFIRMED, not from the stamped since", async () => {
  const h = harness({ advancing: true });
  let slowed = false;
  h.mem.st.onWrite = (v) => { if (!slowed && v.lock) { slowed = true; h.clock.t += 10_000; } }; // a 10 s put
  const at = [];
  h.source.onList = () => at.push(h.clock.t);
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true);
  const since = h.mem.st.writes[0].lock.since;
  assert.ok(at[1] >= since + 10_000 + sw.SETTLE_MS, `second read at +${at[1] - since} ms`);
});

test("copy budget hit mid-copy (advancing clock) ⇒ step copy, resumable message, lock released, master unchanged; re-run completes without duplicates", async () => {
  const h = harness({ sourceEvents: extras(30, "gg"), advancing: true });
  const realUpsert = h.target.upsertEvent;
  let slow = true;
  h.target.upsertEvent = async (e) => { if (slow) h.clock.t += 20_000; return realUpsert(e); };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.step, "copy");
  assert.equal(r.error, sw.COPY_BUDGET_MESSAGE);
  assert.match(r.error, /กดเปลี่ยนอีกครั้ง/);
  assert.equal(h.mem.st.data.lock, undefined);
  assert.equal(h.mem.st.data.master.calendarId, MASTER.calendarId);
  const firstCopied = h.target.events.size;
  assert.ok(firstCopied > 0 && firstCopied < 30);

  slow = false;
  const before = h.target.upserts.length;
  const r2 = await sw.runSwitch(h.deps);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(h.target.upserts.length - before, 30 - firstCopied, "only the missing events are sent");
  assert.equal(r2.unchanged, firstCopied);
  assert.equal(h.target.events.size, 30);
});

test("re-run skips every event whose target copy already matches the source (zero upserts)", async () => {
  const h = harness();
  assert.equal((await sw.runSwitch(h.deps)).ok, true);
  // pretend the flip never happened: same source, same (complete) target
  h.mem.st.data = { master: MASTER, candidate: CANDIDATE };
  const before = h.target.upserts.length;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(h.target.upserts.length, before);
  assert.equal(r.unchanged, 5);
  // a changed summary on a legacy event (no private data) is NOT treated as matching
  h.mem.st.data = { master: MASTER, candidate: CANDIDATE };
  h.source.events.get(LEGACY.id).summary = "A ทดสอบ 1234567 SYNTH-op-changed";
  const r2 = await sw.runSwitch(h.deps);
  assert.equal(r2.ok, true);
  assert.deepEqual(h.target.upserts.slice(before).map((u) => u.id), [LEGACY.id]);
});

test("copy budget is checked before the settle wait", async () => {
  const h = harness({ sourceEvents: extras(5, "hh") });
  const realUpsert = h.target.upsertEvent;
  h.target.upsertEvent = async (e) => { h.clock.t += 40_000; return realUpsert(e); }; // 5 in parallel: +200 s
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "copy");
  assert.equal(r.error, sw.COPY_BUDGET_MESSAGE);
  assert.equal(h.source.listCalls, 1, "no second source read");
  assert.ok(!h.sleeps.some((x) => x.ms > 0 && x.ms <= sw.SETTLE_MS && x.ms !== sw.SETTINGS_SETTLE_MS), "no settle wait");
  assert.equal(h.mem.st.data.lock, undefined);
});

test("copy budget is checked before the flip", async () => {
  const h = harness();
  const realList = h.target.listEvents;
  let n = 0;
  h.target.listEvents = async () => { n += 1; if (n === 2) h.clock.t += 200_000; return realList(); }; // slow verify read
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "copy");
  assert.equal(r.error, sw.COPY_BUDGET_MESSAGE);
  assert.equal(h.mem.st.data.master.calendarId, MASTER.calendarId);
  assert.ok(!h.mem.st.writes.some((w) => w.master?.calendarId === CANDIDATE.calendarId), "no flip write");
  assert.equal(h.mem.st.data.lock, undefined);
});

test("google client: one upsert's retries stop within ~30 s in total (429 backoff included)", async () => {
  let t = 0;
  let posts = 0;
  const { fetchFn } = fakeGoogle((url, init) => {
    if (init.method === "POST") posts += 1;
    t += 4_000; // each attempt takes 4 s
    return new Response("{}", { status: 429 });
  });
  const client = sw.createGoogleCalendarClient({ calendarId: "c", refreshToken: "r" }, {
    fetch: fetchFn, clientId: "cid", clientSecret: "cs", now: () => t, sleep: async (ms) => { t += ms; },
    maxAttempts: 50,
  });
  await assert.rejects(() => client.upsertEvent({ id: "abc0001" }));
  assert.ok(t <= sw.UPSERT_TIME_BUDGET_MS + 4_000, `gave up after ${t} ms`);
  assert.ok(posts >= 2, "it did retry");
  assert.equal(sw.UPSERT_TIME_BUDGET_MS, 30_000);
});

// ---- fix round 3: hard run deadline for everything after the copy --------------------------------------
test("RUN_HARD_DEADLINE_MS is 170 s and every listEvents call gets the absolute deadline (normal run unaffected)", async () => {
  assert.equal(sw.RUN_HARD_DEADLINE_MS, 170_000);
  const h = harness();
  const runStart = h.clock.t;
  const seen = [];
  for (const c of [h.source, h.target]) {
    const real = c.listEvents;
    c.listEvents = async (opts) => { seen.push(opts?.deadline); return real(); };
  }
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(seen.length, 5);
  for (const d of seen) assert.equal(d, runStart + sw.RUN_HARD_DEADLINE_MS);
});

test("a slow source re-read after the copy that crosses the hard deadline ⇒ step copy, no flip, lock released", async () => {
  const h = harness({ advancing: true });
  const real = h.source.listEvents;
  h.source.listEvents = async () => { const out = await real(); if (h.source.listCalls === 2) h.clock.t += 130_000; return out; };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.step, "copy");
  assert.equal(r.error, sw.COPY_BUDGET_MESSAGE);
  assert.equal(h.target.listCalls, 1, "no verify read after the breach");
  assert.ok(!h.mem.st.writes.some((w) => w.master?.calendarId === CANDIDATE.calendarId), "no flip write");
  assert.deepEqual(h.mem.st.data, { master: MASTER, candidate: CANDIDATE });
});

test("a slow final source read crossing the hard deadline ⇒ abort, not flip", async () => {
  const h = harness({ advancing: true });
  const real = h.source.listEvents;
  h.source.listEvents = async () => { const out = await real(); if (h.source.listCalls === 3) h.clock.t += 130_000; return out; };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "copy");
  assert.equal(r.error, sw.COPY_BUDGET_MESSAGE);
  assert.equal(h.source.listCalls, 3);
  assert.deepEqual(h.mem.st.data, { master: MASTER, candidate: CANDIDATE });
});

test("a list call that fails with the client's deadline error maps to step copy with the resumable message", async () => {
  const h = harness();
  h.target.listEvents = async () => {
    h.target.listCalls += 1;
    if (h.target.listCalls === 2) throw Object.assign(new Error("calendar list passed the run deadline"), { deadlineExceeded: true });
    return [...h.target.events.values()].map((e) => structuredClone(e));
  };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "copy");
  assert.equal(r.error, sw.COPY_BUDGET_MESSAGE);
  assert.equal(h.mem.st.data.lock, undefined);
  assert.equal(h.mem.st.data.master.calendarId, MASTER.calendarId);
});

test("google client: pagination stops at the deadline; each page's timeout never exceeds the time left", async () => {
  let t = 1_000;
  let pages = 0;
  const timeouts = [];
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return realTimeout.call(AbortSignal, ms); };
  try {
    const { fetchFn } = fakeGoogle(() => { pages += 1; t += 10_000; return Response.json({ items: [{ id: `p${pages}` }], nextPageToken: `tok${pages}` }); });
    const client = sw.createGoogleCalendarClient({ calendarId: "c", refreshToken: "r" }, { fetch: fetchFn, clientId: "cid", clientSecret: "cs", now: () => t, sleep: async (ms) => { t += ms; } });
    await assert.rejects(() => client.listEvents({ deadline: 1_000 + 35_000 }), (err) => err.deadlineExceeded === true);
    assert.ok(pages <= 4, `fetched ${pages} pages`);
    const listTimeouts = timeouts.slice(1); // the first is the token exchange
    assert.ok(listTimeouts.at(-1) <= 6_000, `last page timeout ${listTimeouts.at(-1)} ms`);
  } finally {
    AbortSignal.timeout = realTimeout;
  }
});

// ---- final fix wave: event ids, preflight blockers, switch-back after a delete ----------------
test("planCopy counts planned events whose id Google's insert-with-id rejects (invalidIds); skipped events never count", () => {
  const ok = (id) => ({ id, start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day" } } });
  const plan = sw.planCopy([
    ok("ab01cd23"), // valid base32hex
    ok("Ab01cd23"), // uppercase
    ok("ab01-cd23"), // hyphen (CalDAV/Outlook style)
    ok("ab01"), // too short
    ok("wxyz0001"), // letters past v
    { ...ok("ab01cd23_20261207"), recurringEventId: "ab01cd23" }, // skipped exception instance: not counted
    PERSONAL, // skipped: not counted
  ]);
  assert.equal(plan.invalidIds, 4);
  assert.equal(sw.planCopy([ok("ab01cd23"), ok("0123456789abcdefghijklmnopqrstuv")]).invalidIds, 0);
  assert.equal(sw.GOOGLE_EVENT_ID_PATTERN.source, "^[a-v0-9]{5,1024}$");
});

test("switchPreflight reports target app events missing from the source and invalid source ids (shared by preview and switch)", () => {
  const ev = (id) => ({ id, start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day", note: "" } } });
  assert.deepEqual(sw.switchPreflight([ev("ev1aaaaa"), ev("ev3aaaaa")], [ev("ev1aaaaa"), ev("ev2aaaaa"), PERSONAL]), { targetConflicts: 1, invalidIds: 0 });
  assert.deepEqual(sw.switchPreflight([ev("ev1aaaaa"), ev("EV-bad")], []), { targetConflicts: 0, invalidIds: 1 });
  assert.deepEqual(sw.switchPreflight([ev("ev1aaaaa")], [PERSONAL]), { targetConflicts: 0, invalidIds: 0 });
});

test("switch back into the OLD calendar after a delete on the new master: refused with the specific message, master unchanged, lock released (engine second line)", async () => {
  // Reproduces the final-review probe with valid ids. B = current master, A = old master (previousMaster),
  // A2 = A reconnected with a fresh token as the candidate. ev2 was deleted on B after the first switch.
  const ev = (id) => ({ id, summary: "x", start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day", note: "" } } });
  const B = t("B");
  const A = t("A");
  const A2 = t("A2");
  const h = harness({ settings: { master: B, previousMaster: A, candidate: A2 }, sourceEvents: [ev("ev1aaaaa"), ev("ev3aaaaa")], targetEvents: [ev("ev1aaaaa"), ev("ev2aaaaa")] });
  h.deps.candidate = A2;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.error, sw.TARGET_CONFLICTS_MESSAGE);
  assert.equal(h.target.upserts.length, 0);
  assert.deepEqual(h.mem.st.data, { master: B, previousMaster: A, candidate: A2 });
});

test("runStart: a budget already spent before the run (preflight) refuses BEFORE the lock (step preflight, nothing written)", async () => {
  const h = harness();
  h.deps.runStart = h.clock.t - sw.COPY_PHASE_BUDGET_MS - 1;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.step, "preflight");
  assert.equal(h.mem.st.writes.length, 0);
  assert.equal(h.source.listCalls + h.target.listCalls, 0);
  // a runStart inside the budget behaves as before
  const h2 = harness();
  h2.deps.runStart = h2.clock.t - 1_000;
  assert.equal((await sw.runSwitch(h2.deps)).ok, true);
});

test("LOCK_HOLD_AFTER_FLIP_MS outlasts the GET settings cache TTL (coupled constants)", async () => {
  const { SETTINGS_CACHE_TTL_MS } = await import("../app/lib/calendar-settings-store.ts");
  assert.ok(sw.LOCK_HOLD_AFTER_FLIP_MS > SETTINGS_CACHE_TTL_MS, `${sw.LOCK_HOLD_AFTER_FLIP_MS} > ${SETTINGS_CACHE_TTL_MS}`);
});

// ---- preview diagnostics (counts and masked shapes only) ----
const dEvent = (id, extra = {}) => ({
  id,
  status: "confirmed",
  summary: "OR17 • SYNTH diag",
  start: { dateTime: "2026-12-01T08:00:00+07:00" },
  end: { dateTime: "2026-12-01T09:00:00+07:00" },
  extendedProperties: { private: { or_queue: "booking", queue_type: "OR17", slot_no: "1", hn: "SYNTH-HN-1" } },
  ...extra,
});

test("diagnostics: each invalid-id reason is counted; one id can count in several reasons", () => {
  const long = "a".repeat(1025);
  const plan = sw.planCopy([
    dEvent("ABCdef123"), // uppercase
    dEvent("abc-def12"), // hyphen
    dEvent("abc_def12"), // underscore
    dEvent("abcd"), // too short
    dEvent(long), // too long
    dEvent("abcxyz123"), // otherChars (w-z)
    dEvent("Ab-_.z"), // uppercase + hyphen + underscore + other
    dEvent("validid01"), // valid, not counted
  ]);
  assert.equal(plan.invalidIds, 7);
  assert.deepEqual(plan.diagnostics.invalidIds.reasons, { uppercase: 2, hyphen: 2, underscore: 2, tooShort: 1, tooLong: 1, otherChars: 2 });
});

test("diagnostics: shapes are masked, truncated at 48 chars, capped at 5 and ordered by count", () => {
  const events = [
    dEvent("AB12cd-9"), dEvent("XY99zz-1"), // same shape AAaaaa-9? (AB12cd-9 -> AA99aa-9)
    dEvent("Qq_1234567"),
    dEvent("Zz-aaaa"), dEvent("Zz-bbbb"), dEvent("Zz-cccc"),
    dEvent("T-1"), dEvent("U_1_2"), dEvent("V.w.x"), dEvent("K-9-9-9"),
    dEvent("A".repeat(60)),
  ];
  const { shapes } = sw.planCopy(events).diagnostics.invalidIds;
  assert.ok(shapes.length <= 5);
  assert.deepEqual(shapes[0], { shape: "Aa-aaaa", count: 3 });
  assert.equal(sw.maskIdShape("AB12cd-9"), "AA99aa-9");
  assert.equal(sw.maskIdShape("a_Z-0"), "a_A-9");
  const trunc = sw.maskIdShape("A".repeat(60));
  assert.equal(trunc, `${"A".repeat(48)}…`);
  for (const s of shapes) assert.ok(s.shape.length <= 49);
});

test("diagnostics: invalid ids by kind (app tagged, legacy, recurring masters)", () => {
  const legacy = {
    id: "LEGACY-ID-1",
    summary: "1234567 SYNTH legacy",
    start: { dateTime: "2026-12-01T08:00:00+07:00" },
    end: { dateTime: "2026-12-01T09:00:00+07:00" },
    extendedProperties: { private: { queue_type: "OR17" } },
  };
  const plan = sw.planCopy([
    dEvent("APP-1"),
    dEvent("APP-2", { recurrence: ["RRULE:FREQ=WEEKLY"] }),
    legacy,
    dEvent("validid01"),
  ]);
  assert.equal(plan.invalidIds, 3);
  assert.deepEqual(plan.diagnostics.invalidIds.byKind, { app: 2, legacy: 1, recurringMasters: 1 });
});

test("diagnostics: recurring masters, exceptions, infinite, byFreq, cancelled exceptions", () => {
  const plan = sw.planCopy([
    dEvent("mast0001", { recurrence: ["RRULE:FREQ=WEEKLY"] }), // infinite weekly, planned
    dEvent("mast0002", { recurrence: ["RRULE:FREQ=DAILY;UNTIL=20270101T000000Z"] }), // finite
    dEvent("mast0003", { recurrence: ["RRULE:FREQ=MONTHLY;COUNT=3", "EXDATE:20270101"] }), // finite
    dEvent("mast0004", { recurrence: ["RRULE:FREQ=YEARLY"] }), // infinite
    dEvent("mast0005", { recurrence: ["RRULE:FREQ=HOURLY"] }), // infinite, other
    dEvent("mast0006", { recurrence: ["RRULE:FREQ=WEEKLY", "RRULE:FREQ=DAILY;COUNT=2"] }), // not every rule infinite
    { id: "plain0001", summary: "x", recurrence: ["RDATE:20270101"], start: { date: "2026-12-01" }, end: { date: "2026-12-02" } }, // master, unreadable, no RRULE
    { id: "mast0001_20270101", status: "cancelled", recurringEventId: "mast0001" },
    { id: "mast0001_20270108", status: "confirmed", recurringEventId: "mast0001" },
  ]);
  const r = plan.diagnostics.recurring;
  assert.equal(r.masters, 7);
  assert.equal(r.exceptionInstances, 2);
  assert.equal(r.exceptionsCancelled, 1);
  assert.equal(r.mastersPlanned, 6);
  assert.equal(r.infiniteMasters, 3);
  assert.deepEqual(r.byFreq, { DAILY: 1, WEEKLY: 2, MONTHLY: 1, YEARLY: 1, other: 2 });
  assert.equal(sw.countRecurring([{ recurrence: ["RRULE:FREQ=WEEKLY"] }, { recurringEventId: "x" }]), 2, "existing recurring count unchanged");
});

test("diagnostics: skippedReasons sum to skipped", () => {
  const plan = sw.planCopy([
    dEvent("keep0001"),
    dEvent("keep0001"), // duplicate
    { id: "cxl00001", status: "cancelled" },
    { id: "exc00001_1", recurringEventId: "exc00001", status: "confirmed" },
    { id: "exc00002_1", recurringEventId: "exc00002", status: "cancelled" },
    { id: "personal1", summary: "Lunch", start: { date: "2026-12-01" } },
    { summary: "no id" },
  ]);
  assert.equal(plan.skipped, 6);
  assert.deepEqual(plan.diagnostics.skippedReasons, { cancelled: 2, recurringException: 1, notReadable: 3 });
  const s = plan.diagnostics.skippedReasons;
  assert.equal(s.cancelled + s.recurringException + s.notReadable, plan.skipped);
});

test("diagnostics: output never contains event text or a full id and is JSON-safe", () => {
  const SECRET_ID = "SecretID-Alpha_9";
  const plan = sw.planCopy([
    dEvent(SECRET_ID, { summary: "SECRET-SUMMARY", description: "SECRET-DESC", location: "SECRET-LOC", attendees: [{ email: "secret@example.com" }], recurrence: ["RRULE:FREQ=WEEKLY"] }),
    dEvent("Another-Secret_Id2", { summary: "SECRET-SUMMARY-2" }),
  ]);
  const text = JSON.stringify(plan.diagnostics);
  assert.deepEqual(JSON.parse(text), plan.diagnostics);
  for (const leak of ["SECRET", "secret", SECRET_ID, "Another-Secret_Id2", "SYNTH", "SecretID", "Alpha"]) assert.ok(!text.includes(leak), leak);
  assert.equal(plan.diagnostics.invalidIds.shapes.length, 2);
});
