// Copy engine for the Admin master-calendar switch. In-memory fakes only: no network, no Blob,
// synthetic events (no patient data).
import assert from "node:assert/strict";
import test from "node:test";
import "./ts-resolve.mjs";

const sw = await import("../app/lib/calendar-switch.ts");
const { expandEvents, isOccurrenceOf, renderZone } = await import("./fake-expand.mjs");
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
const EXTRA = { id: "ea0001aa", summary: "SYNTH extra", start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day", note: "" } } };
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

test("planCopy carries a recurring master's recurrence; its exception instances become exception items (not copied as events)", () => {
  const master = { ...structuredClone(LEGACY), id: "rm0001aa", recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"] };
  const exception = { ...structuredClone(LEGACY), id: "rm0001aa_20261210", recurringEventId: "rm0001aa" };
  const plan = sw.planCopy([master, exception]);
  assert.deepEqual(plan.copy.map((e) => e.id), ["rm0001aa"]);
  assert.deepEqual(plan.copy[0].recurrence, master.recurrence);
  // step 2: an exception of a planned master is applied after the copy, no longer skipped
  assert.equal(plan.skipped, 0);
  assert.deepEqual(plan.exceptions.map((x) => [x.kind, x.id]), [["modify", "rm0001aa_20261210"]]);
});

// ---- fakes ----------------------------------------------------------------------
function fakeCalendar(name, log, events = []) {
  const c = {
    events: new Map(events.map((e) => [e.id, structuredClone(e)])),
    listCalls: 0,
    expandCalls: 0,
    upserts: [],
    failOnUpsert: null,
    failList: null,
    failExpand: null,
    onList: null,
    onExpand: null,
    // the calendar's own time zone (hours); Google renders dateTimes in it unless the read passes timeZone
    zone: undefined,
    render(events, opts) {
      const zone = opts?.timeZone === "Asia/Bangkok" ? 7 : c.zone;
      return zone === undefined ? events : renderZone(events, zone);
    },
    // opts.expand = singleEvents=true over a window (counted separately so the numbering of the plain
    // reads, which existing tests rely on, is unchanged)
    async listEvents(opts) {
      if (opts?.expand) {
        c.expandCalls += 1;
        log.push(`${name}.expand`);
        if (c.onExpand) c.onExpand(c.expandCalls, c);
        if (c.failExpand && c.failExpand(c.expandCalls)) throw new Error(`SYNTH google expand failed token=${name}-SECRET`);
        return c.render(expandEvents([...c.events.values()], opts.expand), opts);
      }
      c.listCalls += 1;
      log.push(`${name}.list`);
      if (c.onList) c.onList(c.listCalls, c);
      if (c.failList && c.failList(c.listCalls)) throw new Error(`SYNTH google list failed token=${name}-SECRET`);
      return c.render([...c.events.values()].map((e) => structuredClone(e)), opts);
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
    // Recurring-instance writes, strict like Google: the master (with recurrence) must already be in this
    // calendar, otherwise the instance id is unknown (404). Stored instances carry recurringEventId and
    // originalStartTime, as Google lists them (singleEvents=false).
    instanceOps: [],
    missingInstances: new Set(),
    swallowDelete: false,
    failOnInstanceOp: null,
    instance(id) {
      const masterId = id.slice(0, id.indexOf("_"));
      const master = c.events.get(masterId);
      const known = !!master && Array.isArray(master.recurrence) && master.recurrence.length > 0 && !c.missingInstances.has(id);
      return { masterId, known, suffix: id.slice(id.indexOf("_") + 1) };
    },
    // PUT (events.update): the body REPLACES the occurrence (nothing inherited from the master)
    async updateInstance(id, body) {
      log.push(`${name}.put`);
      const n = c.instanceOps.length + 1;
      c.instanceOps.push({ op: "put", id });
      if (c.failOnInstanceOp === n) throw new Error(`SYNTH google put failed token=${name}-SECRET`);
      const { masterId, known, suffix } = c.instance(id);
      // like Google: 404 unless the id is an occurrence of the master's rule
      if (!known || !isOccurrenceOf(c.events.get(masterId), id)) throw Object.assign(new Error(`SYNTH 404 token=${name}-SECRET`), { status: 404, instanceMissing: true });
      const prev = c.events.get(id);
      c.events.set(id, { ...structuredClone(body), id, recurringEventId: masterId, originalStartTime: body.originalStartTime ?? prev?.originalStartTime ?? { synth: suffix } });
    },
    async deleteInstance(id) {
      log.push(`${name}.delete`);
      const n = c.instanceOps.length + 1;
      c.instanceOps.push({ op: "delete", id });
      if (c.failOnInstanceOp === n) throw new Error(`SYNTH google delete failed token=${name}-SECRET`);
      const { masterId, known, suffix } = c.instance(id);
      if (!known || c.swallowDelete) return "gone"; // 404
      const prev = c.events.get(id);
      if (prev?.status === "cancelled") return "gone"; // 410
      c.events.set(id, { id, status: "cancelled", recurringEventId: masterId, originalStartTime: prev?.originalStartTime ?? { synth: suffix } });
      return "deleted";
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
  // (fix round 1: the source is also read in the app's view — still read-only)
  assert.ok(!h.log.some((l) => l.startsWith("source.") && l !== "source.list" && l !== "source.expand"));
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
  h.target.listEvents = async (opts) => {
    const events = await realList(opts);
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
  h.target.listEvents = async (opts) => (await realList(opts)).filter((e) => e.id !== LEGACY.id);
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
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `ea${String(i).padStart(4, "0")}bb`, start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day" } } }));
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
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `ea${String(i).padStart(4, "0")}cc`, start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day" } } }));
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
  const many = Array.from({ length: 23 }, (_, i) => ({ id: `ea${String(i).padStart(4, "0")}dd`, start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day" } } }));
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
  h.target.listEvents = async (opts) => { inFlightAtList.push(inFlight); return realList(opts); };
  const sourceList = h.source.listEvents;
  const inFlightAtSource = [];
  h.source.listEvents = async (opts) => { inFlightAtSource.push(inFlight); return sourceList(opts); };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(maxInFlight, 5);
  // target: before, verify, expanded verify; source: 3 reads, each with its expanded read
  assert.deepEqual(inFlightAtList, [0, 0, 0]);
  assert.deepEqual(inFlightAtSource, [0, 0, 0, 0, 0, 0]);
  assert.equal(h.target.events.size, 23);
});

test("lock renewal is serialized while 5 workers copy (never two renewals at once)", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `ea${String(i).padStart(4, "0")}ee`, start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day" } } }));
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
  h.target.listEvents = async (opts) => {
    n += 1;
    const events = await realList(opts);
    if (n < 2) return events;
    return events.map((e) => (e.id === BOOKING.id ? { ...e, extendedProperties: { private: { ...e.extendedProperties.private, slot_no: "9" } } } : e));
  };
  assert.equal((await sw.runSwitch(h.deps)).step, "verify");
  const h2 = harness();
  const real2 = h2.target.listEvents;
  let m = 0;
  h2.target.listEvents = async (opts) => {
    m += 1;
    const events = await real2(opts);
    return m < 2 ? events : events.map((e) => (e.id === EXTRA.id ? { ...e, end: { date: "2026-12-09" } } : e));
  };
  assert.equal((await sw.runSwitch(h2.deps)).step, "verify");
  assert.equal(h2.mem.st.data.master.calendarId, MASTER.calendarId);
});

test("verify accepts the same instant written in another time-zone offset and a different key order", async () => {
  // fix round 2: the per-item verify compares instants; the app's view (expanded read, rendered in the
  // app's zone) must also match on wall-clock time, so only the plain list is re-rendered here
  const h = harness();
  const realList = h.target.listEvents;
  h.target.listEvents = async (opts) => {
    const events = await realList(opts);
    if (opts?.expand) return events;
    return events.map((e) => {
      if (e.id !== BOOKING.id) return e;
      const priv = Object.fromEntries(Object.entries(e.extendedProperties.private).reverse());
      return { ...e, start: { timeZone: "Asia/Bangkok", dateTime: "2026-12-01T01:00:00Z" }, end: { timeZone: "Asia/Bangkok", dateTime: "2026-12-01T02:00:00Z" }, extendedProperties: { private: priv } };
    });
  };
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
const extras = (n, tag) => Array.from({ length: n }, (_, i) => ({ id: `ea${String(i).padStart(4, "0")}${tag}`, start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day" } } }));

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
  h.target.listEvents = async (opts) => { n += 1; if (n === 2) h.clock.t += 200_000; return realList(opts); }; // slow verify read
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
    c.listEvents = async (opts) => { seen.push(opts?.deadline); return real(opts); };
  }
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(seen.length, 9); // 3 source reads + 3 expanded, target before + verify + expanded verify
  for (const d of seen) assert.equal(d, runStart + sw.RUN_HARD_DEADLINE_MS);
});

test("a slow source re-read after the copy that crosses the hard deadline ⇒ step copy, no flip, lock released", async () => {
  const h = harness({ advancing: true });
  const real = h.source.listEvents;
  h.source.listEvents = async (opts) => { const out = await real(opts); if (h.source.listCalls === 2) h.clock.t += 130_000; return out; };
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
  h.source.listEvents = async (opts) => { const out = await real(opts); if (h.source.listCalls === 3) h.clock.t += 130_000; return out; };
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

test("switchPreflight reports target app events missing from the source, remapped ids, exceptions and plan refusals (shared by preview and switch)", () => {
  const ev = (id) => ({ id, start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day", note: "" } } });
  const none = { modify: 0, cancel: 0 };
  const zero = { uncoveredOccurrences: 0, orphanedExceptions: 0 };
  assert.deepEqual(sw.switchPreflight([ev("ev1aaaaa"), ev("ev3aaaaa")], [ev("ev1aaaaa"), ev("ev2aaaaa"), PERSONAL]), { targetConflicts: 1, invalidIds: 0, exceptions: none, refusal: null, ...zero });
  // step 2: an invalid id is remapped (informational count), not a refusal
  assert.deepEqual(sw.switchPreflight([ev("ev1aaaaa"), ev("EV-bad")], []), { targetConflicts: 0, invalidIds: 1, exceptions: none, refusal: null, ...zero });
  assert.deepEqual(sw.switchPreflight([ev("ev1aaaaa")], [PERSONAL]), { targetConflicts: 0, invalidIds: 0, exceptions: none, refusal: null, ...zero });
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

test("diagnostics: shapes are run-length masked, capped at 5, ordered by count then alphabet, with shapesOmitted", () => {
  assert.equal(sw.maskIdShape("AB12cd-9"), "U4l2-l1"); // digits join the run before them; all-digit segment = l
  assert.equal(sw.maskIdShape("abc_20240105T010000Z"), "l3_U16"); // leading digits join the first letter run after them
  assert.equal(sw.maskIdShape("123abc"), "l6");
  assert.equal(sw.maskIdShape("Zz-aaaa"), "U1l1-l4");
  assert.equal(sw.maskIdShape("a b\tc"), "l1?1l1?1l1");
  const events = [
    dEvent("Zz-aaaa"), dEvent("Zz-bbbb"), dEvent("Zz-cccc"), // one shape x3
    dEvent("Tt-1"), dEvent("Tt-2"), // U1l1-l1 x2
    dEvent("U_1_2"), dEvent("V.w.x"), dEvent("K-9-9-9"), dEvent("Q-Q-Q-Q-Q"), dEvent("m-m-m-m-m-m"),
  ];
  const plan = sw.planCopy(events);
  const { shapes, shapesOmitted } = plan.diagnostics.invalidIds;
  assert.equal(shapes.length, 5);
  assert.deepEqual(shapes[0], { shape: "U1l1-l4", count: 3 });
  assert.deepEqual(shapes[1], { shape: "U1l1-l1", count: 2 });
  assert.equal(plan.invalidIds, 10);
  assert.equal(shapesOmitted, plan.invalidIds - shapes.reduce((n, x) => n + x.count, 0));
  assert.equal(shapesOmitted, 2);
  for (const x of shapes) assert.ok(Array.from(x.shape).length <= 49);
});

test("diagnostics: uppercase UUIDs (incl. all-digit segments) collapse into one shape", () => {
  // 17 ids, several segments all digits on purpose
  const ids = [
    "12345678-ABCD-1234-ABCD-1234567890AB",
    "ABCDEF01-1234-4ABC-9ABC-123456789012",
    "12345678-1234-1234-1234-123456789ABC",
    ...Array.from({ length: 14 }, (_, i) => `${String(10000000 + i * 7)}-${i % 2 ? "1234" : "A2B3"}-4${String(100 + i)}-8C${i % 10}D-ABCDEF12${String(1000 + i)}`),
  ];
  const plan = sw.planCopy(ids.map((id) => dEvent(id)));
  assert.equal(plan.invalidIds, 17);
  assert.deepEqual(plan.diagnostics.invalidIds.shapes, [{ shape: "U8-U4-U4-U4-U12", count: 17 }]);
  assert.equal(plan.diagnostics.invalidIds.shapesOmitted, 0);
  assert.equal(sw.maskIdShape("12345678-ABCD-1234-ABCD-1234567890AB"), "U8-U4-U4-U4-U12");
  assert.equal(sw.maskIdShape("12345678-abcd-1234-abcd-1234567890ab"), "l8-l4-l4-l4-l12");
  assert.equal(sw.maskIdShape("abcdef01-1a2b-3c4d-5e6f-123456789abc"), "l8-l4-l4-l4-l12");
  assert.equal(sw.maskIdShape("12345678-1234-1234-1234-123456789012"), "l8-l4-l4-l4-l12", "digits-only id is l");
  assert.ok(sw.maskIdShape("12345678-ABCD-1234-abcd-1234567890AB").startsWith("l8-U4-l4-l4-"), "mixed case: all-digit segments are l");
});

test("diagnostics: 1000 random uppercase UUIDs give exactly one shape", () => {
  const ids = Array.from({ length: 1000 }, () => globalThis.crypto.randomUUID().toUpperCase());
  assert.ok(ids.some((id) => id.split("-").some((seg) => /^[0-9]+$/.test(seg))), "all-digit segments occur");
  const plan = sw.planCopy(ids.map((id) => dEvent(id)));
  assert.equal(plan.invalidIds, 1000);
  assert.deepEqual(plan.diagnostics.invalidIds.shapes, [{ shape: "U8-U4-U4-U4-U12", count: 1000 }]);
  assert.equal(plan.diagnostics.invalidIds.shapesOmitted, 0);
});

test("diagnostics: non-ASCII, emoji and whitespace in ids never reach the output; truncation keeps valid strings", () => {
  const pieces = ["สมชาย1234567", "Café9", "ＡＢＣ１２３", "ok\u{1F600}id", "a b\tc\nd", "x".repeat(10) + "-" + "\u{1F600}-".repeat(30), "-\u{1F600}".repeat(24) + "\u{1F600}"];
  const plan = sw.planCopy(pieces.map((id) => dEvent(id)));
  const text = JSON.stringify(plan.diagnostics);
  for (const bad of ["สมชาย", "é", "Ａ", "１", "\u{1F600}", " ", "\\t", "\\n", "Caf"]) assert.ok(!text.includes(bad), JSON.stringify(bad));
  for (const { shape } of plan.diagnostics.invalidIds.shapes) {
    assert.ok(Array.from(shape).length <= 49);
    assert.ok(/^[A-Za-z0-9?\-_.:@/+=…]*$/.test(shape), shape);
    assert.equal(shape, shape.toWellFormed());
  }
  assert.equal(sw.maskIdShape("สมชาย1234567"), "?5l7");
  assert.equal(sw.maskIdShape("ok\u{1F600}id"), "l2?1l2");
  const long = sw.maskIdShape("-\u{1F600}".repeat(40));
  assert.equal(long, `${"-?1".repeat(16)}…`);
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

// ==== step 2: remap ids Google rejects; copy recurring exceptions of planned masters ====
const { createHash } = await import("node:crypto");
// The production shape: "_" + 58 lowercase letters/digits (hand-typed legacy events). Synthetic.
const BAD_ID = "_" + "a1b2c3d4e5".repeat(5) + "zyxwvuts";
const BAD_ID_2 = "_" + "f6g7h8i9j0".repeat(5) + "qrstuvwx";
const BAD_LEGACY = { ...structuredClone(LEGACY), id: BAD_ID, extendedProperties: { private: { custom: "keep" } } };
const expectRemap = (id) => `oi${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 40)}`;

test("remapEventId: deterministic oi + 40 hex of sha256, always a valid Google id; valid ids keep their id", () => {
  assert.equal(sw.remapEventId(BAD_ID), expectRemap(BAD_ID));
  assert.equal(sw.remapEventId(BAD_ID), sw.remapEventId(BAD_ID));
  assert.notEqual(sw.remapEventId(BAD_ID), sw.remapEventId(BAD_ID_2));
  for (const id of [BAD_ID, "Outlook-1", "ab", "x".repeat(2000), "สมชาย"]) {
    const out = sw.remapEventId(id);
    assert.match(out, sw.GOOGLE_EVENT_ID_PATTERN);
    assert.equal(out.length, 42);
  }
  assert.equal(sw.planTargetId("ab01cd23"), "ab01cd23");
  assert.equal(sw.planTargetId(BAD_ID), expectRemap(BAD_ID));
});

test("planCopy remaps an invalid id: body id = targetId, orig_id = source id, other private props and orig_* kept", () => {
  const plan = sw.planCopy([BAD_LEGACY, structuredClone(BOOKING)]);
  const byId = new Map(plan.copy.map((e) => [e.id, e]));
  const remapped = byId.get(expectRemap(BAD_ID));
  assert.ok(remapped, "copied under the new id");
  assert.equal(remapped.extendedProperties.private.orig_id, BAD_ID);
  assert.equal(remapped.extendedProperties.private.custom, "keep");
  assert.equal(remapped.extendedProperties.private.orig_created, LEGACY.created);
  assert.equal(plan.invalidIds, 1);
  assert.equal(plan.refusal, null);
  // a valid id is copied as before, without orig_id
  assert.equal(byId.get(BOOKING.id).extendedProperties.private.orig_id, undefined);
  // an orig_id the source already carries wins (a later switch keeps the first id)
  const chained = { ...structuredClone(BAD_LEGACY), extendedProperties: { private: { orig_id: "first-id" } } };
  assert.equal(sw.planCopy([chained]).copy[0].extendedProperties.private.orig_id, "first-id");
});

test("a remapped legacy event is still read by the app's legacy parser after the copy (only the id differs)", () => {
  const copied = asCopiedInTarget(BAD_LEGACY);
  assert.equal(copied.id, expectRemap(BAD_ID));
  const before = legacyMod.parseLegacyCalendarEvent(BAD_LEGACY);
  const after = legacyMod.parseLegacyCalendarEvent(copied);
  assert.ok(before && after);
  assert.deepEqual({ ...after, id: "x" }, { ...before, id: "x" });
  assert.equal(after.id, expectRemap(BAD_ID));
  assert.equal(sw.classifyEvent(copied), "legacy");
});

test("two source ids mapping to the same target id are refused (collision), before any write", async () => {
  const twin = { ...structuredClone(EXTRA), id: expectRemap(BAD_ID) }; // a valid id equal to BAD_ID's remap
  const plan = sw.planCopy([BAD_LEGACY, twin]);
  assert.equal(plan.refusal, sw.ID_COLLISION_MESSAGE);
  assert.equal(sw.switchPreflight([BAD_LEGACY, twin], []).refusal, sw.ID_COLLISION_MESSAGE);
  assert.match(sw.ID_COLLISION_MESSAGE, /ยังไม่ได้เปลี่ยนปฏิทิน/);
  // the engine's second line: no upsert, master unchanged, lock released
  const h = harness({ sourceEvents: [BAD_LEGACY, twin] });
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.error, sw.ID_COLLISION_MESSAGE);
  assert.equal(h.target.upserts.length, 0);
  assert.deepEqual(h.mem.st.data, { master: MASTER, candidate: CANDIDATE });
});

test("runSwitch copies a remapped event under its target id; verify, final re-read and a re-run all use target ids", async () => {
  const h = harness({ sourceEvents: [...ALL(), structuredClone(BAD_LEGACY)] });
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.copied, 6);
  assert.ok(h.target.events.has(expectRemap(BAD_ID)));
  assert.ok(!h.target.events.has(BAD_ID));
  assert.equal(h.target.events.get(expectRemap(BAD_ID)).extendedProperties.private.orig_id, BAD_ID);
  // the copied target holds no conflict for the same source
  assert.equal(sw.switchPreflight([...h.source.events.values()], [...h.target.events.values()]).targetConflicts, 0);
  // re-run (flip pretended away): zero upserts
  h.mem.st.data = { master: MASTER, candidate: CANDIDATE };
  const before = h.target.upserts.length;
  const r2 = await sw.runSwitch(h.deps);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(h.target.upserts.length, before);
  assert.equal(r2.unchanged, 6);
});

test("verify fails when a remapped event is missing from the target", async () => {
  const h = harness({ sourceEvents: [...ALL(), structuredClone(BAD_LEGACY)] });
  const realList = h.target.listEvents;
  h.target.listEvents = async (opts) => (await realList(opts)).filter((e) => e.id !== expectRemap(BAD_ID));
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "verify");
  assert.equal(h.mem.st.data.master.calendarId, MASTER.calendarId);
});

// ---- recurring exceptions ----
const R_MASTER = { id: "rm0001aa", status: "confirmed", summary: "A ทดสอบ 1234567 SYNTH-weekly", start: { date: "2026-12-03" }, end: { date: "2026-12-04" }, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"], created: "2025-05-05T00:00:00Z", updated: "2025-06-06T00:00:00Z" };
const R_MOD = { id: "rm0001aa_20261210", status: "confirmed", recurringEventId: "rm0001aa", originalStartTime: { date: "2026-12-10" }, summary: "A ทดสอบ 1234567 SYNTH-moved", start: { date: "2026-12-14" }, end: { date: "2026-12-15" }, created: "2025-05-05T00:00:00Z", updated: "2025-07-07T00:00:00Z", etag: "\"9\"", extendedProperties: { private: { custom: "x" } } };
const R_CXL = { id: "rm0001aa_20261217", status: "cancelled", recurringEventId: "rm0001aa", originalStartTime: { date: "2026-12-17" } };
const T_MASTER = { id: "tm0001aa", status: "confirmed", summary: "SYNTH timed", start: { dateTime: "2026-12-01T08:00:00+07:00", timeZone: "Asia/Bangkok" }, end: { dateTime: "2026-12-01T09:00:00+07:00", timeZone: "Asia/Bangkok" }, recurrence: ["RRULE:FREQ=WEEKLY"], extendedProperties: { private: { or_queue: "extra_day", note: "" } } };
const T_MOD = { id: "tm0001aa_20261208T010000Z", status: "confirmed", recurringEventId: "tm0001aa", originalStartTime: { dateTime: "2026-12-08T08:00:00+07:00", timeZone: "Asia/Bangkok" }, summary: "SYNTH timed moved", start: { dateTime: "2026-12-09T08:00:00+07:00", timeZone: "Asia/Bangkok" }, end: { dateTime: "2026-12-09T09:00:00+07:00", timeZone: "Asia/Bangkok" }, extendedProperties: { private: { or_queue: "extra_day", note: "moved" } } };
const REC = () => structuredClone([R_MOD, R_CXL, R_MASTER, T_MASTER, T_MOD]); // exceptions listed BEFORE their masters on purpose

test("planCopy builds exception items for planned masters (modify / cancel) and no longer counts them as skipped", () => {
  const plan = sw.planCopy(REC());
  assert.deepEqual(plan.copy.map((e) => e.id).sort(), ["rm0001aa", "tm0001aa"]);
  const items = Object.fromEntries(plan.exceptions.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(items).sort(), ["rm0001aa_20261210", "rm0001aa_20261217", "tm0001aa_20261208T010000Z"]);
  assert.equal(items.rm0001aa_20261210.kind, "modify");
  assert.equal(items.rm0001aa_20261217.kind, "cancel");
  assert.equal(items.rm0001aa_20261210.masterId, "rm0001aa");
  // the modify body is the FULL exception for a PUT (+ orig_*): its original start and master (target id),
  // never its own id or server fields (fix round 1: PUT replaces; PATCH inherited the master's fields)
  const body = items.rm0001aa_20261210.body;
  for (const k of ["id", "etag", "created", "updated", "recurrence"]) assert.ok(!(k in body), k);
  assert.deepEqual(body.originalStartTime, R_MOD.originalStartTime);
  assert.equal(body.recurringEventId, "rm0001aa");
  assert.deepEqual(body.start, R_MOD.start);
  assert.equal(body.summary, R_MOD.summary);
  assert.equal(body.status, "confirmed");
  assert.equal(body.extendedProperties.private.custom, "x");
  assert.equal(body.extendedProperties.private.orig_updated, R_MOD.updated);
  assert.equal(plan.skipped, 0);
  assert.deepEqual(plan.diagnostics.skippedReasons, { cancelled: 0, recurringException: 0, notReadable: 0 });
  assert.deepEqual(plan.diagnostics.exceptions, { modify: 2, cancel: 1 });
  assert.equal(plan.refusal, null);
  // diagnostics.recurring still describes every source exception
  assert.equal(plan.diagnostics.recurring.exceptionInstances, 3);
  assert.equal(plan.diagnostics.recurring.exceptionsCancelled, 1);
});

test("exceptions of masters that are not planned stay skipped (by their old reason)", () => {
  const orphanMod = { ...structuredClone(R_MOD), id: "zz0001aa_20261210", recurringEventId: "zz0001aa" };
  const orphanCxl = { ...structuredClone(R_CXL), id: "zz0001aa_20261217", recurringEventId: "zz0001aa" };
  const personalMaster = { id: "pm0001aa", summary: "Lunch", start: { date: "2026-12-03" }, end: { date: "2026-12-04" }, recurrence: ["RRULE:FREQ=WEEKLY"] };
  const personalExc = { id: "pm0001aa_20261210", recurringEventId: "pm0001aa", status: "confirmed", summary: "Lunch", start: { date: "2026-12-11" }, end: { date: "2026-12-12" } };
  const plan = sw.planCopy([orphanMod, orphanCxl, personalMaster, personalExc]);
  assert.equal(plan.exceptions.length, 0);
  assert.equal(plan.skipped, 4);
  assert.deepEqual(plan.diagnostics.skippedReasons, { cancelled: 1, recurringException: 2, notReadable: 1 });
  assert.deepEqual(plan.diagnostics.exceptions, { modify: 0, cancel: 0 });
});

test("instance id: suffix from the exception id; else from originalStartTime (dateTime → UTC basic, date → YYYYMMDD); else refusal", () => {
  const odd = (id, ost) => ({ id, status: "confirmed", recurringEventId: "rm0001aa", originalStartTime: ost, summary: "x", start: { date: "2026-12-11" }, end: { date: "2026-12-12" } });
  const plan = sw.planCopy([
    structuredClone(R_MASTER),
    odd("rm0001aa_20261210", { date: "2026-12-10" }),
    odd("weird0001", { dateTime: "2026-12-24T08:30:00+07:00" }),
    odd("weird0002", { date: "2026-12-31" }),
  ]);
  assert.deepEqual(plan.exceptions.map((x) => x.id).sort(), ["rm0001aa_20261210", "rm0001aa_20261224T013000Z", "rm0001aa_20261231"]);
  assert.equal(plan.refusal, null);
  const bad = sw.planCopy([structuredClone(R_MASTER), odd("weird0003", {})]);
  assert.equal(bad.refusal, sw.EXCEPTION_INSTANCE_ID_MESSAGE);
  const bad2 = sw.planCopy([structuredClone(R_MASTER), odd("weird0004", { dateTime: "not a date" })]);
  assert.equal(bad2.refusal, sw.EXCEPTION_INSTANCE_ID_MESSAGE);
  // a remapped master maps its exceptions under the NEW id: refused (never silently misapplied)
  const badMaster = { ...structuredClone(R_MASTER), id: BAD_ID };
  const badExc = { ...structuredClone(R_MOD), id: `${BAD_ID}_20261210`, recurringEventId: BAD_ID };
  const p3 = sw.planCopy([badMaster, badExc]);
  assert.equal(p3.refusal, sw.REMAPPED_MASTER_EXCEPTION_MESSAGE);
  assert.equal(sw.switchPreflight([badMaster, badExc], []).refusal, sw.REMAPPED_MASTER_EXCEPTION_MESSAGE);
  // a remapped master without exceptions is fine
  assert.equal(sw.planCopy([badMaster]).refusal, null);
  for (const m of [sw.EXCEPTION_INSTANCE_ID_MESSAGE, sw.REMAPPED_MASTER_EXCEPTION_MESSAGE, sw.ID_COLLISION_MESSAGE]) {
    assert.match(m, /ยังไม่ได้เปลี่ยนปฏิทิน/);
    assert.doesNotMatch(m, /กดเปลี่ยนอีกครั้ง/);
  }
});

test("runSwitch refuses an exception of a remapped master before any write to the target", async () => {
  const badMaster = { ...structuredClone(R_MASTER), id: BAD_ID };
  const badExc = { ...structuredClone(R_MOD), id: `${BAD_ID}_20261210`, recurringEventId: BAD_ID };
  const h = harness({ sourceEvents: [...ALL(), badMaster, badExc] });
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.error, sw.REMAPPED_MASTER_EXCEPTION_MESSAGE);
  assert.equal(h.target.upserts.length + h.target.instanceOps.length, 0);
  assert.equal(h.mem.st.data.lock, undefined);
});

test("runSwitch applies modify and cancel exceptions AFTER every master/normal upsert and before the second source read", async () => {
  const h = harness({ sourceEvents: [...ALL(), ...REC()] });
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  const lastUpsert = h.log.lastIndexOf("target.upsert");
  const firstInstance = h.log.findIndex((l) => l === "target.put" || l === "target.delete");
  assert.ok(firstInstance > lastUpsert, "instances after all upserts");
  const secondSourceRead = h.log.indexOf("source.list", h.log.indexOf("source.list") + 1);
  assert.ok(firstInstance < secondSourceRead, "instances before the second source read");
  const mod = h.target.events.get("rm0001aa_20261210");
  assert.equal(mod.summary, R_MOD.summary);
  assert.deepEqual(mod.start, R_MOD.start);
  assert.equal(mod.recurringEventId, "rm0001aa");
  assert.equal(h.target.events.get("rm0001aa_20261217").status, "cancelled");
  assert.equal(h.target.events.get("tm0001aa_20261208T010000Z").extendedProperties.private.note, "moved");
  assert.deepEqual(h.target.instanceOps.map((o) => o.op).sort(), ["delete", "put", "put"]);
  assert.deepEqual(r.exceptions, { modify: 2, cancel: 1, applied: 3, unchanged: 0 });
  assert.equal(r.skipped, 3);
  assert.ok(!JSON.stringify(r).includes("rm0001aa"), "no ids in the result");
});

test("re-run is idempotent: already-correct exceptions are skipped; a cancel answered 404/410 counts as done", async () => {
  const h = harness({ sourceEvents: [...ALL(), ...REC()] });
  assert.equal((await sw.runSwitch(h.deps)).ok, true);
  h.mem.st.data = { master: MASTER, candidate: CANDIDATE };
  const ops = h.target.instanceOps.length;
  const ups = h.target.upserts.length;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(h.target.instanceOps.length, ops, "zero instance writes");
  assert.equal(h.target.upserts.length, ups, "zero upserts");
  assert.deepEqual(r.exceptions, { modify: 2, cancel: 1, applied: 0, unchanged: 3 });
  // the engine itself treats "gone" (404/410) as a completed cancel
  const h2 = harness({ sourceEvents: [...ALL(), ...REC()] });
  const realDelete = h2.target.deleteInstance;
  h2.target.deleteInstance = async (id) => { await realDelete(id); return "gone"; };
  assert.equal((await sw.runSwitch(h2.deps)).ok, true);
});

test("a re-sent master gets its exceptions re-applied even when the target copy looked right", async () => {
  const h = harness({ sourceEvents: [...ALL(), ...REC()] });
  assert.equal((await sw.runSwitch(h.deps)).ok, true);
  h.mem.st.data = { master: MASTER, candidate: CANDIDATE };
  h.source.events.get("rm0001aa").description = "SYNTH changed master";
  const ops = h.target.instanceOps.length;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(h.target.instanceOps.slice(ops).map((o) => o.id).sort(), ["rm0001aa_20261210", "rm0001aa_20261217"]);
});

test("a cancel answered 404 with nothing cancelled in the target fails verify (wrong instance id never passes)", async () => {
  const h = harness({ sourceEvents: [...ALL(), ...REC()] });
  h.target.swallowDelete = true;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.step, "verify");
  assert.equal(h.mem.st.data.master.calendarId, MASTER.calendarId);
  assert.equal(h.mem.st.data.lock, undefined);
});

test("a modify answered 404 (instance unknown) stops at copy with a fixed, non-resumable message", async () => {
  const h = harness({ sourceEvents: [...ALL(), ...REC()] });
  h.target.missingInstances.add("rm0001aa_20261210");
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.step, "copy");
  assert.equal(r.error, sw.EXCEPTION_APPLY_FAILED_MESSAGE);
  assert.doesNotMatch(r.error, /กดเปลี่ยนอีกครั้ง/);
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  assert.equal(h.mem.st.data.lock, undefined);
  assert.equal(h.mem.st.data.master.calendarId, MASTER.calendarId);
});

test("verify fails when a modified exception is missing or differs in the target", async () => {
  for (const mutate of [
    (events) => events.filter((e) => e.id !== "rm0001aa_20261210"),
    (events) => events.map((e) => (e.id === "rm0001aa_20261210" ? { ...e, start: { date: "2026-12-10" }, end: { date: "2026-12-11" } } : e)),
    (events) => events.map((e) => (e.id === "rm0001aa_20261210" ? { ...e, summary: "other" } : e)),
    // the cancelled occurrence is back (consistently in both views)
    (events, opts) => (opts?.expand
      ? [...events, { id: "rm0001aa_20261217", status: "confirmed", recurringEventId: "rm0001aa", summary: R_MASTER.summary, start: { date: "2026-12-17" }, end: { date: "2026-12-18" } }]
      : events.map((e) => (e.id === "rm0001aa_20261217" ? { ...e, status: "confirmed" } : e))),
  ]) {
    const h = harness({ sourceEvents: [...ALL(), ...REC()] });
    const realList = h.target.listEvents;
    let n = 0;
    h.target.listEvents = async (opts) => { n += 1; const events = await realList(opts); return n < 2 ? events : mutate(events, opts); };
    const r = await sw.runSwitch(h.deps);
    assert.equal(r.step, "verify", JSON.stringify(r));
    assert.equal(h.mem.st.data.master.calendarId, MASTER.calendarId);
  }
});

test("the verify read of the target asks for deleted entries (showDeleted) so cancelled instances are visible", async () => {
  const h = harness({ sourceEvents: [...ALL(), ...REC()] });
  const seen = [];
  const realList = h.target.listEvents;
  h.target.listEvents = async (opts) => { if (!opts?.expand) seen.push(opts?.showDeleted); return realList(opts); };
  const srcSeen = [];
  const realSrc = h.source.listEvents;
  h.source.listEvents = async (opts) => { srcSeen.push(opts?.showDeleted); return realSrc(opts); };
  assert.equal((await sw.runSwitch(h.deps)).ok, true);
  assert.deepEqual(seen, [true, true]);
  assert.ok(srcSeen.every((x) => !x), "source reads never ask for deleted events");
});

test("an exception added to the source between the first and second read is applied via the delta", async () => {
  const h = harness({ sourceEvents: [...ALL(), ...REC()] });
  const late = { id: "rm0001aa_20261224", status: "cancelled", recurringEventId: "rm0001aa", originalStartTime: { date: "2026-12-24" } };
  h.source.onList = (n, c) => { if (n === 2) c.events.set(late.id, structuredClone(late)); };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(h.target.events.get(late.id).status, "cancelled");
  assert.equal(r.exceptions.cancel, 2);
});

test("an exception appearing in the source after the second read (final re-read) aborts the switch", async () => {
  const h = harness({ sourceEvents: [...ALL(), ...REC()] });
  const late = { id: "rm0001aa_20261224", status: "cancelled", recurringEventId: "rm0001aa", originalStartTime: { date: "2026-12-24" } };
  h.source.onList = (n, c) => { if (n === 3) c.events.set(late.id, structuredClone(late)); };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.step, "verify");
  assert.equal(h.mem.st.data.master.calendarId, MASTER.calendarId);
  assert.equal(h.mem.st.data.lock, undefined);
});

test("target conflicts: an exception of a planned master that the source does not have is a conflict; planned ones are not", () => {
  const src = [structuredClone(R_MASTER), structuredClone(R_MOD)];
  const stray = { id: "rm0001aa_20261224", status: "cancelled", recurringEventId: "rm0001aa", originalStartTime: { date: "2026-12-24" } };
  assert.equal(sw.switchPreflight(src, [structuredClone(R_MASTER), structuredClone(R_MOD)]).targetConflicts, 0);
  assert.equal(sw.switchPreflight(src, [structuredClone(R_MASTER), structuredClone(R_MOD), stray]).targetConflicts, 1);
  // exceptions of masters the app does not copy are ignored
  const other = { id: "pm0001aa_20261210", recurringEventId: "pm0001aa", status: "cancelled" };
  assert.equal(sw.switchPreflight(src, [other]).targetConflicts, 0);
  assert.deepEqual(sw.switchPreflight(REC(), []).exceptions, { modify: 2, cancel: 1 });
});

test("exception writes respect the 5-concurrency limit", async () => {
  const many = Array.from({ length: 23 }, (_, i) => ({ id: `rm0001aa_202612${String(i + 1).padStart(2, "0")}`, status: "cancelled", recurringEventId: "rm0001aa", originalStartTime: { date: `2026-12-${String(i + 1).padStart(2, "0")}` } }));
  const h = harness({ sourceEvents: [structuredClone(R_MASTER), ...many] });
  let inFlight = 0;
  let maxInFlight = 0;
  const realDelete = h.target.deleteInstance;
  h.target.deleteInstance = async (id) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1 + (id.charCodeAt(id.length - 1) % 3)));
    try { return await realDelete(id); } finally { inFlight -= 1; }
  };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(maxInFlight, 5);
  assert.equal(r.exceptions.cancel, 23);
});

test("copy budget hit during the exception writes ⇒ step copy, resumable, lock released; the re-run finishes only the rest", async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `rm0001aa_202612${String(i + 1).padStart(2, "0")}`, status: "cancelled", recurringEventId: "rm0001aa", originalStartTime: { date: `2026-12-${String(i + 1).padStart(2, "0")}` } }));
  const h = harness({ sourceEvents: [structuredClone(R_MASTER), ...many], advancing: true });
  let slow = true;
  const realDelete = h.target.deleteInstance;
  h.target.deleteInstance = async (id) => { if (slow) h.clock.t += 20_000; return realDelete(id); };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.step, "copy");
  assert.equal(r.error, sw.COPY_BUDGET_MESSAGE);
  assert.equal(h.mem.st.data.lock, undefined);
  assert.equal(h.mem.st.data.master.calendarId, MASTER.calendarId);
  const done = [...h.target.events.values()].filter((e) => e.status === "cancelled").length;
  assert.ok(done > 0 && done < 20, `${done} cancelled in the first press`);
  slow = false;
  const ops = h.target.instanceOps.length;
  const r2 = await sw.runSwitch(h.deps);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(h.target.instanceOps.length - ops, 20 - done);
});

test("an exception write failure stops at copy (resumable), releases the lock, never leaks the token", async () => {
  const h = harness({ sourceEvents: [...ALL(), ...REC()] });
  h.target.failOnInstanceOp = 1;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "copy");
  assert.equal(r.error, sw.SWITCH_STEP_MESSAGES.copy);
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  assert.equal(h.mem.st.data.lock, undefined);
});

test("google client: updateInstance = PUT (events.update) on the instance id (sendUpdates=none), never PATCH; 404/410 flagged instanceMissing", async () => {
  const { seen, fetchFn } = fakeGoogle((url, init) => {
    if (init.method === "PUT") return url.includes("missing") ? new Response("{}", { status: 404 }) : Response.json({ id: "x" });
    return new Response("{}", { status: 500 });
  });
  const client = sw.createGoogleCalendarClient({ calendarId: "c1", refreshToken: "r" }, { fetch: fetchFn, clientId: "cid", clientSecret: "cs", sleep: async () => {} });
  await client.updateInstance("rm0001aa_20261210", { summary: "s", start: { date: "2026-12-14" } });
  const put = seen.find((s) => s.init.method === "PUT");
  assert.equal(new URL(put.url).pathname, "/calendar/v3/calendars/c1/events/rm0001aa_20261210");
  assert.equal(new URL(put.url).searchParams.get("sendUpdates"), "none");
  assert.deepEqual(JSON.parse(put.init.body), { summary: "s", start: { date: "2026-12-14" } });
  assert.ok(!seen.some((s) => s.init.method === "PATCH"));
  assert.equal(client.patchInstance, undefined);
  await assert.rejects(() => client.updateInstance("missing0001_20261210", { summary: "s" }), (err) => err.instanceMissing === true && !/s"/.test(err.message));
});

test("google client: deleteInstance = DELETE (sendUpdates=none); 204 → deleted, 404/410 → gone, other errors throw fixed text", async () => {
  const { seen, fetchFn } = fakeGoogle((url, init) => {
    if (init.method !== "DELETE") return new Response("{}", { status: 500 });
    if (url.includes("gone404")) return new Response("{}", { status: 404 });
    if (url.includes("gone410")) return new Response("{}", { status: 410 });
    if (url.includes("bad")) return Response.json({ error: { message: "SYNTH-GOOGLE-TEXT" } }, { status: 403 });
    return new Response(null, { status: 204 });
  });
  const client = sw.createGoogleCalendarClient({ calendarId: "c1", refreshToken: "r" }, { fetch: fetchFn, clientId: "cid", clientSecret: "cs", sleep: async () => {} });
  assert.equal(await client.deleteInstance("ok0001aa_20261210"), "deleted");
  const del = seen.find((s) => s.init.method === "DELETE");
  assert.equal(new URL(del.url).pathname, "/calendar/v3/calendars/c1/events/ok0001aa_20261210");
  assert.equal(new URL(del.url).searchParams.get("sendUpdates"), "none");
  assert.equal(await client.deleteInstance("gone404_20261210"), "gone");
  assert.equal(await client.deleteInstance("gone410_20261210"), "gone");
  await assert.rejects(() => client.deleteInstance("bad0001_20261210"), (err) => !String(err.message).includes("SYNTH-GOOGLE-TEXT"));
});

test("google client: listEvents({ showDeleted: true }) asks Google for deleted entries; default stays false", async () => {
  const { seen, fetchFn } = fakeGoogle(() => Response.json({ items: [] }));
  const client = sw.createGoogleCalendarClient({ calendarId: "c1", refreshToken: "r" }, { fetch: fetchFn, clientId: "cid", clientSecret: "cs", sleep: async () => {} });
  await client.listEvents();
  await client.listEvents({ showDeleted: true });
  const lists = seen.filter((s) => s.url.includes("/events"));
  assert.equal(new URL(lists[0].url).searchParams.get("showDeleted"), "false");
  assert.equal(new URL(lists[1].url).searchParams.get("showDeleted"), "true");
  assert.equal(new URL(lists[1].url).searchParams.get("singleEvents"), "false");
});

// ==== step 2 fix round 1: app-view parity (the app reads singleEvents=true expansions) ====
const WIN = { timeMin: "2000-01-01T00:00:00.000Z", timeMax: new Date(Date.now() + 400 * 86_400_000).toISOString() }; // = the engine's window (tested below)
const expand = (events) => expandEvents(events.map((e) => structuredClone(e)), WIN);
// 2026-12-03 Thursday, 2026-12-04 Friday, 2026-12-07 Monday
const P_MASTER = { id: "pm0001aa", status: "confirmed", summary: "Lunch", start: { date: "2026-12-03" }, end: { date: "2026-12-04" }, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"] };
const P_EXC = { id: "pm0001aa_20261210", status: "confirmed", recurringEventId: "pm0001aa", originalStartTime: { date: "2026-12-10" }, summary: "A ทดสอบ 1234567 SYNTH-op", start: { date: "2026-12-10" }, end: { date: "2026-12-11" } };
const F_MASTER = { id: "fm0001aa", status: "confirmed", summary: "A ทดสอบ 1234567 SYNTH-op", start: { date: "2026-12-04" }, end: { date: "2026-12-05" }, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=FR,MO;COUNT=4"] };
const APP_TAGS = ["booking", "extra_day", "schedule_closure", "staff_unavailable"];
const readableIds = (events) => events.filter((e) => e.status !== "cancelled" && (legacyMod.parseLegacyCalendarEvent(e) || APP_TAGS.includes(e.extendedProperties?.private?.or_queue))).map((e) => e.id).sort();

test("expansionWindow: 2000-01-01 … now + 400 days (ISO)", () => {
  const at = Date.parse("2026-11-15T00:00:00Z");
  assert.deepEqual(sw.expansionWindow(at), { timeMin: "2000-01-01T00:00:00.000Z", timeMax: "2027-12-20T00:00:00.000Z" });
});

test("probe1 (Critical 1): a personal weekly master whose exception the app reads is planned through the expansion", () => {
  assert.ok(legacyMod.parseLegacyCalendarEvent(P_EXC), "the app reads the exception");
  const source = [P_MASTER, P_EXC];
  const plan = sw.planCopy(source, expand(source));
  assert.deepEqual(plan.copy.map((e) => e.id), ["pm0001aa"]);
  assert.deepEqual(plan.exceptions.map((x) => [x.kind, x.id]), [["modify", "pm0001aa_20261210"]]);
  assert.equal(plan.uncoveredOccurrences, 0);
  assert.equal(plan.refusal, null);
});

test("probe2 (Critical 2): a BYDAY=FR,MO master starting on a Friday is planned because its Monday occurrences are read", () => {
  assert.equal(sw.classifyEvent(F_MASTER), null, "the master itself is not readable (Friday)");
  const plan = sw.planCopy([F_MASTER], expand([F_MASTER]));
  assert.deepEqual(plan.copy.map((e) => e.id), ["fm0001aa"]);
  assert.equal(plan.counts.legacy, 1);
  assert.equal(plan.uncoveredOccurrences, 0);
});

test("runSwitch copies probe1 + probe2 so the target shows exactly the occurrences the app reads in the source", async () => {
  const h = harness({ sourceEvents: [...ALL(), P_MASTER, P_EXC, F_MASTER] });
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  const src = readableIds(expand([...h.source.events.values()]));
  const tgt = readableIds(expand([...h.target.events.values()]));
  assert.deepEqual(tgt, src);
  assert.ok(tgt.includes("fm0001aa_20261207") && tgt.includes("pm0001aa_20261210"));
});

test("probe1 P-I: a cancelled exception with a foreign id gets the UTC instance id from originalStartTime (+07:00)", () => {
  const m2 = { id: "rm0002aa", summary: "A ทดสอบ 1234567 x", start: { dateTime: "2026-12-03T08:00:00+07:00", timeZone: "Asia/Bangkok" }, end: { dateTime: "2026-12-03T09:00:00+07:00", timeZone: "Asia/Bangkok" }, recurrence: ["RRULE:FREQ=WEEKLY"] };
  const e2 = { id: "foreign", recurringEventId: "rm0002aa", status: "cancelled", originalStartTime: { dateTime: "2026-12-10T08:00:00+07:00", timeZone: "Asia/Bangkok" } };
  assert.deepEqual(sw.planCopy([m2, e2]).exceptions, [{ kind: "cancel", id: "rm0002aa_20261210T010000Z", masterId: "rm0002aa" }]);
});

test("probe1 P-J: a deleted copy in the target is never a conflict", () => {
  const BK = { id: "bk0001aa", status: "confirmed", summary: "s", start: { date: "2026-12-07" }, end: { date: "2026-12-08" }, extendedProperties: { private: { or_queue: "extra_day" } } };
  assert.equal(sw.switchPreflight([BK], [{ ...BK, status: "cancelled" }]).targetConflicts, 0);
  assert.equal(sw.switchPreflight([], [{ ...BK, status: "cancelled" }]).targetConflicts, 0);
});

test("probe1 P-K: a cancelled target exception of an occurrence the source does not show (EXDATE) is not a conflict; one the source shows is", () => {
  const m3 = { id: "rm0002aa", summary: "A ทดสอบ 1234567 x", start: { dateTime: "2026-12-03T08:00:00+07:00", timeZone: "Asia/Bangkok" }, end: { dateTime: "2026-12-03T09:00:00+07:00", timeZone: "Asia/Bangkok" }, recurrence: ["EXDATE;TZID=Asia/Bangkok:20261210T080000", "RRULE:FREQ=WEEKLY;COUNT=4"] };
  const stray = (suffix, local) => ({ id: `rm0002aa_${suffix}`, status: "cancelled", recurringEventId: "rm0002aa", originalStartTime: { dateTime: local } });
  const exp = expand([m3]);
  assert.equal(sw.switchPreflight([m3], [m3, stray("20261210T010000Z", "2026-12-10T08:00:00+07:00")], exp).targetConflicts, 0);
  assert.equal(sw.switchPreflight([m3], [m3, stray("20261217T010000Z", "2026-12-17T08:00:00+07:00")], exp).targetConflicts, 1);
  assert.equal(sw.planCopy([m3], exp).diagnostics.recurring.rruleExtras, 1);
});

test("rruleExtras counts planned masters with EXDATE / RDATE / EXRULE lines only", () => {
  const m = (id, recurrence) => ({ ...structuredClone(R_MASTER), id, recurrence });
  const source = [
    m("ma0001aa", ["RRULE:FREQ=WEEKLY;COUNT=2"]),
    m("ma0002aa", ["EXDATE;VALUE=DATE:20261210", "RRULE:FREQ=WEEKLY;COUNT=4"]),
    m("ma0003aa", ["RDATE;VALUE=DATE:20261216", "RRULE:FREQ=WEEKLY;COUNT=2"]),
    m("ma0004aa", ["EXRULE:FREQ=MONTHLY", "RRULE:FREQ=WEEKLY;COUNT=2"]),
    { ...structuredClone(P_MASTER), id: "pm0002aa", recurrence: ["EXDATE;VALUE=DATE:20261210", "RRULE:FREQ=WEEKLY;COUNT=2"] }, // not planned
  ];
  assert.equal(sw.planCopy(source, expand(source)).diagnostics.recurring.rruleExtras, 3);
});

test("uncovered occurrences: a readable occurrence the plan does not cover is counted and refused", () => {
  // the expansion shows a readable occurrence whose master is missing from the plain list
  const occurrence = { ...structuredClone(P_EXC), id: "zq0001aa_20261210", recurringEventId: "zq0001aa" };
  const plan = sw.planCopy([], [occurrence]);
  assert.equal(plan.uncoveredOccurrences, 1);
  assert.equal(plan.diagnostics.uncoveredOccurrences, 1);
  assert.equal(plan.refusal, sw.UNCOVERED_OCCURRENCES_MESSAGE);
  assert.match(sw.UNCOVERED_OCCURRENCES_MESSAGE, /ยังไม่ได้เปลี่ยนปฏิทิน/);
  assert.match(sw.UNCOVERED_OCCURRENCES_MESSAGE, /ติดต่อผู้พัฒนา/);
  assert.doesNotMatch(sw.UNCOVERED_OCCURRENCES_MESSAGE, /กดเปลี่ยนอีกครั้ง/);
  assert.equal(sw.switchPreflight([], [], [occurrence]).uncoveredOccurrences, 1);
  // everything covered: 0
  assert.equal(sw.planCopy(ALL(), expand(ALL())).uncoveredOccurrences, 0);
});

test("runSwitch refuses uncovered occurrences before any write (engine second line)", async () => {
  const h = harness({ sourceEvents: [...ALL(), P_MASTER, P_EXC] });
  const real = h.source.listEvents;
  h.source.listEvents = async (opts) => (await real(opts)).filter((e) => opts?.expand || e.id !== "pm0001aa"); // master hidden from the plain list
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.error, sw.UNCOVERED_OCCURRENCES_MESSAGE);
  assert.equal(h.target.upserts.length + h.target.instanceOps.length, 0);
  assert.equal(h.mem.st.data.lock, undefined);
});

// final gate: wraps the target's EXPANDED read only
function gateHarness(mutate, extra = []) {
  const h = harness({ sourceEvents: [...ALL(), ...REC(), ...extra] });
  const real = h.target.listEvents;
  h.target.listEvents = async (opts) => {
    const events = await real(opts);
    return opts?.expand ? mutate(events) : events;
  };
  return h;
}

test("final gate: a readable occurrence missing from the target expansion fails verify (no flip, lock released)", async () => {
  const h = gateHarness((events) => events.filter((e) => e.id !== "rm0001aa_20261224"));
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "verify", JSON.stringify(r));
  assert.deepEqual(h.mem.st.data, { master: MASTER, candidate: CANDIDATE });
});

test("final gate: an extra readable occurrence in the target fails verify", async () => {
  const ghost = { ...structuredClone(LEGACY), id: "gh0001aa", summary: "A ทดสอบ 7654321 SYNTH-ghost" };
  const h = gateHarness((events) => [...events, ghost]);
  assert.equal((await sw.runSwitch(h.deps)).step, "verify");
  assert.equal(h.mem.st.data.lock, undefined);
});

test("final gate: content drift (summary, description, location, private props, start) fails verify; orig_* props are ignored", async () => {
  const drifts = [
    (e) => ({ ...e, description: "SYNTH inherited master description" }),
    (e) => ({ ...e, location: "SYNTH other room" }),
    (e) => ({ ...e, summary: "A ทดสอบ 1234567 SYNTH-other" }),
    (e) => ({ ...e, start: { date: "2026-12-15" }, end: { date: "2026-12-16" } }),
  ];
  for (const drift of drifts) {
    const h = gateHarness((events) => events.map((e) => (e.id === "rm0001aa_20261210" ? drift(e) : e)));
    assert.equal((await sw.runSwitch(h.deps)).step, "verify");
  }
  const hp = gateHarness((events) => events.map((e) => (e.id === "tm0001aa_20261215T010000Z" ? { ...e, extendedProperties: { private: { ...e.extendedProperties.private, note: "x" } } } : e)));
  assert.equal((await sw.runSwitch(hp.deps)).step, "verify");
  const ok = gateHarness((events) => events.map((e) => (e.id === LEGACY.id ? { ...e, extendedProperties: { private: { ...(e.extendedProperties?.private ?? {}), orig_created: "x", orig_updated: "y", orig_id: "z" } } } : e)));
  assert.equal((await sw.runSwitch(ok.deps)).ok, true);
});

test("PUT replaces the occurrence: a description the master has but the exception lacks is NOT inherited (PATCH would fail the gate)", async () => {
  const master = { ...structuredClone(R_MASTER), description: "SYNTH master description" };
  const exc = structuredClone(R_MOD); // no description
  const h = harness({ sourceEvents: [master, exc] });
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(h.target.events.get(exc.id).description, undefined);
  assert.ok(h.target.instanceOps.every((o) => o.op !== "patch"));
  // a PATCH-like merge that inherits the master's description is caught by the gate
  const h2 = harness({ sourceEvents: [master, exc] });
  h2.target.updateInstance = async (id, body) => {
    const masterId = id.slice(0, id.indexOf("_"));
    h2.target.events.set(id, { description: h2.target.events.get(masterId).description, ...structuredClone(body), id, recurringEventId: masterId });
  };
  assert.equal((await sw.runSwitch(h2.deps)).step, "verify");
});

test("smoke fact 5: re-sending a master wipes its modified occurrences in Google; the run re-applies them and passes the gate", async () => {
  const h = harness({ sourceEvents: [...ALL(), ...REC()] });
  assert.equal((await sw.runSwitch(h.deps)).ok, true);
  h.mem.st.data = { master: MASTER, candidate: CANDIDATE };
  h.source.events.get("rm0001aa").description = "SYNTH changed master";
  const realUpsert = h.target.upsertEvent;
  h.target.upsertEvent = async (e) => {
    const out = await realUpsert(e);
    // Google: a PUT on the master reverts modified exceptions (cancelled ones survive)
    for (const [id, ev] of h.target.events) if (ev.recurringEventId === e.id && ev.status !== "cancelled") h.target.events.delete(id);
    return out;
  };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(h.target.events.get("rm0001aa_20261210").summary, R_MOD.summary);
});

test("orphans: a modified exception that is not an occurrence of the source expansion is not applied and is counted (non-blocking)", async () => {
  const orphanMod = { ...structuredClone(R_MOD), id: "rm0001aa_20261231", originalStartTime: { date: "2026-12-31" }, start: { date: "2027-01-01" }, end: { date: "2027-01-02" } };
  const source = [...ALL(), ...REC(), orphanMod];
  const plan = sw.planCopy(source, expand(source));
  assert.equal(plan.diagnostics.orphanedExceptions, 1);
  assert.ok(!plan.exceptions.some((x) => x.id === orphanMod.id));
  assert.equal(plan.refusal, null);
  const h = harness({ sourceEvents: source });
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!h.target.instanceOps.some((o) => o.id === orphanMod.id));
  // outside the window nothing can be decided: it is still applied
  const far = { ...structuredClone(orphanMod), id: "rm0001aa_20991231", originalStartTime: { date: "2099-12-31" } };
  const p2 = sw.planCopy([R_MASTER, far], expand([R_MASTER, far]));
  assert.deepEqual(p2.exceptions.map((x) => x.id), [far.id]);
  assert.equal(p2.diagnostics.orphanedExceptions, 0);
});

test("orphans: a cancel of an occurrence that does not exist is still sent; Google's 404 plus absence from the target expansion verifies it", async () => {
  const orphanCxl = { id: "rm0001aa_20261231", status: "cancelled", recurringEventId: "rm0001aa", originalStartTime: { date: "2026-12-31" } };
  const h = harness({ sourceEvents: [...ALL(), ...REC(), orphanCxl] });
  h.target.missingInstances.add(orphanCxl.id); // DELETE answers 404, nothing is stored
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(h.target.instanceOps.some((o) => o.op === "delete" && o.id === orphanCxl.id));
  assert.ok(!h.target.events.has(orphanCxl.id));
});

test("an occurrence added to the source expansion during the copy (final re-read) aborts the switch", async () => {
  const h = harness({ sourceEvents: [...ALL(), ...REC()] });
  const late = { ...structuredClone(LEGACY), id: "la0001aa", summary: "A ทดสอบ 7654321 SYNTH-late" };
  h.source.onExpand = (n, c) => { if (n === 3) c.events.set(late.id, structuredClone(late)); };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.step, "verify");
  assert.equal(h.mem.st.data.master.calendarId, MASTER.calendarId);
  assert.equal(h.mem.st.data.lock, undefined);
});

test("the expanded reads use singleEvents over the window and carry the hard deadline", async () => {
  const h = harness();
  const seen = [];
  for (const c of [h.source, h.target]) {
    const real = c.listEvents;
    c.listEvents = async (opts) => { if (opts?.expand) seen.push(opts); return real(opts); };
  }
  assert.equal((await sw.runSwitch(h.deps)).ok, true);
  assert.equal(seen.length, 4); // 3 source + 1 target
  for (const o of seen) {
    assert.equal(o.expand.timeMin, "2000-01-01T00:00:00.000Z");
    assert.ok(Math.abs(Date.parse(o.expand.timeMax) - (Date.now() + 400 * 86_400_000)) < 60_000);
    assert.equal(typeof o.deadline, "number");
  }
});

test("a slow expanded read crossing the hard deadline ⇒ step copy (resumable), no flip; a failing expanded read ⇒ step read", async () => {
  const h = harness({ advancing: true });
  h.source.onExpand = (n) => { if (n === 2) h.clock.t += 130_000; };
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "copy");
  assert.equal(r.error, sw.COPY_BUDGET_MESSAGE);
  assert.ok(!h.mem.st.writes.some((w) => w.master?.calendarId === CANDIDATE.calendarId));
  assert.equal(h.mem.st.data.lock, undefined);
  const h2 = harness();
  h2.source.failExpand = (n) => n === 1;
  const r2 = await sw.runSwitch(h2.deps);
  assert.equal(r2.step, "read");
  assert.ok(!JSON.stringify(r2).includes("SECRET"));
  assert.equal(h2.mem.st.data.lock, undefined);
  const h3 = harness();
  const realT = h3.target.listEvents;
  h3.target.listEvents = async (opts) => {
    if (opts?.expand) throw Object.assign(new Error("calendar list passed the run deadline"), { deadlineExceeded: true });
    return realT(opts);
  };
  const r3 = await sw.runSwitch(h3.deps);
  assert.equal(r3.step, "copy");
  assert.equal(r3.error, sw.COPY_BUDGET_MESSAGE);
});

test("google client: listEvents({ expand }) = singleEvents=true with timeMin/timeMax, paginated, deadline-bounded", async () => {
  const { seen, fetchFn } = fakeGoogle((url) => {
    const page = new URL(url).searchParams.get("pageToken");
    return page ? Response.json({ items: [{ id: "b" }] }) : Response.json({ items: [{ id: "a" }], nextPageToken: "p2" });
  });
  const client = sw.createGoogleCalendarClient({ calendarId: "c1", refreshToken: "r" }, { fetch: fetchFn, clientId: "cid", clientSecret: "cs", sleep: async () => {} });
  const out = await client.listEvents({ expand: { timeMin: "2000-01-01T00:00:00.000Z", timeMax: "2027-12-20T00:00:00.000Z" } });
  assert.deepEqual(out.map((e) => e.id), ["a", "b"]);
  const lists = seen.filter((s) => s.url.includes("/events"));
  for (const l of lists) {
    const q = new URL(l.url).searchParams;
    assert.equal(q.get("singleEvents"), "true");
    assert.equal(q.get("timeMin"), "2000-01-01T00:00:00.000Z");
    assert.equal(q.get("timeMax"), "2027-12-20T00:00:00.000Z");
    assert.equal(q.get("showDeleted"), "false");
  }
});

// ==== step 2 fix round 2: time zone, moved-out exceptions, cancels outside the window, minors ====
const WIN2 = { timeMin: "2000-01-01T00:00:00.000Z", timeMax: "2027-12-20T00:00:00.000Z" };
// weekly Tuesday master readable by itself; its 2027-12-14 occurrence (inside WIN2) moved to 2027-12-28 (outside)
const MM_MASTER = { id: "mm0001aa", status: "confirmed", summary: "A ทดสอบ 1234567 SYNTH op", start: { dateTime: "2027-11-30T08:00:00+07:00", timeZone: "Asia/Bangkok" }, end: { dateTime: "2027-11-30T09:00:00+07:00", timeZone: "Asia/Bangkok" }, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"] };
const MM_MOVED = { id: "mm0001aa_20271214T010000Z", status: "confirmed", recurringEventId: "mm0001aa", originalStartTime: { dateTime: "2027-12-14T08:00:00+07:00", timeZone: "Asia/Bangkok" }, summary: "A ทดสอบ 7654321 SYNTH moved", start: { dateTime: "2027-12-28T08:00:00+07:00", timeZone: "Asia/Bangkok" }, end: { dateTime: "2027-12-28T09:00:00+07:00", timeZone: "Asia/Bangkok" } };

test("probe moved-out (Important 2): an exception moved beyond the window is applied, never counted as an orphan", async () => {
  const source = [MM_MASTER, MM_MOVED];
  const expanded = expandEvents(structuredClone(source), WIN2);
  assert.ok(!expanded.some((e) => e.id === MM_MOVED.id), "Google (and the fake) filter by the occurrence's own start");
  const plan = sw.planCopy(source, expanded, WIN2);
  assert.equal(plan.diagnostics.orphanedExceptions, 0);
  assert.deepEqual(plan.exceptions.map((x) => [x.kind, x.id]), [["modify", MM_MOVED.id]]);
  assert.equal(plan.refusal, null);
  const h = harness({ sourceEvents: [...ALL(), ...source] });
  h.deps.window = WIN2;
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(h.target.instanceOps.some((o) => o.op === "put" && o.id === MM_MOVED.id));
  assert.equal(h.target.events.get(MM_MOVED.id).summary, MM_MOVED.summary);
  // a moved-out exception that the target does not hold fails the per-item check (the gate cannot see it)
  const h2 = harness({ sourceEvents: [...ALL(), ...source] });
  h2.deps.window = WIN2;
  const real = h2.target.listEvents;
  h2.target.listEvents = async (opts) => (await real(opts)).filter((e) => opts?.expand || e.id !== MM_MOVED.id);
  assert.equal((await sw.runSwitch(h2.deps)).step, "verify");
});

test("orphan only when BOTH the original start and its own start are inside the window (and it is not in the view)", () => {
  // original 2026-12-31 is not an occurrence (COUNT=4); own start 2027-01-01: both inside → orphan
  const inside = { ...structuredClone(R_MOD), id: "rm0001aa_20261231", originalStartTime: { date: "2026-12-31" }, start: { date: "2027-01-01" }, end: { date: "2027-01-02" } };
  const p1 = sw.planCopy([R_MASTER, inside], expandEvents(structuredClone([R_MASTER, inside]), WIN2), WIN2);
  assert.equal(p1.diagnostics.orphanedExceptions, 1);
  // same original, own start beyond the window → not an orphan: applied
  const out = { ...structuredClone(inside), start: { date: "2028-06-01" }, end: { date: "2028-06-02" } };
  const p2 = sw.planCopy([R_MASTER, out], expandEvents(structuredClone([R_MASTER, out]), WIN2), WIN2);
  assert.equal(p2.diagnostics.orphanedExceptions, 0);
  assert.deepEqual(p2.exceptions.map((x) => x.id), [out.id]);
});

test("Important 3: a cancel whose original start is outside the window, answered 404/410, is satisfied (per-item only)", async () => {
  const farCxl = { id: "rm0001aa_20991231", status: "cancelled", recurringEventId: "rm0001aa", originalStartTime: { date: "2099-12-31" } };
  const h = harness({ sourceEvents: [...ALL(), ...REC(), farCxl] });
  h.target.missingInstances.add(farCxl.id); // DELETE answers 404; nothing is stored
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(h.target.instanceOps.some((o) => o.op === "delete" && o.id === farCxl.id));
  // inside the window a "gone" cancel whose occurrence is still visible keeps failing (unchanged)
  const h2 = harness({ sourceEvents: [...ALL(), ...REC()] });
  h2.target.swallowDelete = true;
  assert.equal((await sw.runSwitch(h2.deps)).step, "verify");
});

test("Important 1: every list read the engine makes passes timeZone=Asia/Bangkok", async () => {
  const h = harness({ sourceEvents: [...ALL(), ...REC()] });
  const seen = [];
  for (const c of [h.source, h.target]) {
    const real = c.listEvents;
    c.listEvents = async (opts) => { seen.push(opts?.timeZone); return real(opts); };
  }
  assert.equal((await sw.runSwitch(h.deps)).ok, true);
  assert.equal(seen.length, 9);
  assert.ok(seen.every((z) => z === "Asia/Bangkok"), JSON.stringify(seen));
  assert.equal(sw.APP_TIME_ZONE, "Asia/Bangkok");
});

test("Important 1: a target calendar in another zone still passes (both sides read in Bangkok time)", async () => {
  const h = harness({ sourceEvents: [...ALL(), ...REC()] });
  h.source.zone = 7;
  h.target.zone = 0; // UTC calendar: without timeZone its dateTimes would come back as ...Z
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("Important 1: a wall-clock mismatch in the app's view (same instant, other zone) fails the final gate", async () => {
  const h = harness({ sourceEvents: [...ALL(), ...REC()] });
  h.target.zone = 0;
  const real = h.target.listEvents;
  // the target ignores the requested zone: its view renders bookings in UTC (other dates for early slots)
  h.target.listEvents = async (opts) => real(opts?.expand ? { ...opts, timeZone: undefined } : opts);
  const r = await sw.runSwitch(h.deps);
  assert.equal(r.step, "verify", JSON.stringify(r));
  assert.equal(h.mem.st.data.master.calendarId, MASTER.calendarId);
});

test("probe zone: the same instant rendered in another zone is a different app view (date differs)", () => {
  const a = { id: "bk0001aa", start: { dateTime: "2027-01-05T00:30:00+07:00" }, end: { dateTime: "2027-01-05T01:30:00+07:00" }, extendedProperties: { private: { or_queue: "booking", queue_type: "OR17" } } };
  const b = { ...a, start: { dateTime: "2027-01-04T17:30:00Z" }, end: { dateTime: "2027-01-04T18:30:00Z" } };
  const pa = sw.planCopy([a], [a], WIN2);
  const pb = sw.planCopy([b], [b], WIN2);
  assert.notDeepEqual(pa.byMonth, undefined);
  assert.equal(sw.sameAppView([...pa.occurrences.values()][0], [...pb.occurrences.values()][0]), false);
  assert.equal(sw.sameAppView([...pa.occurrences.values()][0], [...pa.occurrences.values()][0]), true);
});

test("minor (c): a readable exception of an UNPLANNED master outside the window is uncovered (refused); cancelled ones are not", () => {
  const farReadable = { ...structuredClone(P_EXC), id: "pm0001aa_20261217", originalStartTime: { date: "2026-12-17" }, start: { date: "2028-06-01" }, end: { date: "2028-06-02" } };
  const farCancelled = { id: "pm0001aa_20261224", status: "cancelled", recurringEventId: "pm0001aa", originalStartTime: { date: "2026-12-24" } };
  const p = sw.planCopy([P_MASTER, farReadable], expandEvents(structuredClone([P_MASTER, farReadable]), WIN2), WIN2);
  assert.equal(p.uncoveredOccurrences, 1);
  assert.equal(p.refusal, sw.UNCOVERED_OCCURRENCES_MESSAGE);
  const p2 = sw.planCopy([P_MASTER, farCancelled], expandEvents(structuredClone([P_MASTER, farCancelled]), WIN2), WIN2);
  assert.equal(p2.uncoveredOccurrences, 0);
  assert.equal(p2.refusal, null);
});

test("minor (d): a master planned through occurrences takes the kind of its EARLIEST readable occurrence, whatever the list order", () => {
  // Friday master (unreadable itself) with a Monday legacy occurrence (12-07) and a later tagged one (12-14)
  const tagged = { id: "fm0001aa_20261214", status: "confirmed", recurringEventId: "fm0001aa", originalStartTime: { date: "2026-12-14" }, summary: "x", start: { date: "2026-12-14" }, end: { date: "2026-12-15" }, extendedProperties: { private: { or_queue: "extra_day" } } };
  const source = [F_MASTER, tagged];
  const view = expandEvents(structuredClone(source), WIN2);
  const a = sw.planCopy(source, view, WIN2);
  const b = sw.planCopy(source, [...view].reverse(), WIN2);
  assert.equal(a.counts.legacy, 1);
  assert.deepEqual(a.counts, b.counts);
});

test("fake parity (minor f): updateInstance answers 404 for an id that is not an occurrence of its master", async () => {
  const h = harness({ sourceEvents: [structuredClone(R_MASTER)] });
  await h.target.upsertEvent(sw.planCopy([R_MASTER]).copy[0]);
  await assert.rejects(() => h.target.updateInstance("rm0001aa_20261211", { summary: "x" }), (err) => err.instanceMissing === true);
  await h.target.updateInstance("rm0001aa_20261210", { summary: "x" });
});

test("google client: expanded reads use a fields projection that keeps nextPageToken (pagination continues); plain reads stay full; timeZone is passed", async () => {
  const { seen, fetchFn } = fakeGoogle((url) => {
    const q = new URL(url).searchParams;
    const fields = q.get("fields");
    // a projection without nextPageToken would silently stop pagination
    const next = !fields || fields.includes("nextPageToken");
    const page = q.get("pageToken");
    if (!page) return Response.json({ items: [{ id: "a" }], ...(next ? { nextPageToken: "p2" } : {}) });
    return Response.json({ items: [{ id: "b" }] });
  });
  const client = sw.createGoogleCalendarClient({ calendarId: "c1", refreshToken: "r" }, { fetch: fetchFn, clientId: "cid", clientSecret: "cs", sleep: async () => {} });
  const out = await client.listEvents({ expand: { timeMin: "2000-01-01T00:00:00.000Z", timeMax: "2027-12-20T00:00:00.000Z" }, timeZone: "Asia/Bangkok" });
  assert.deepEqual(out.map((e) => e.id), ["a", "b"]);
  const expanded = seen.filter((s) => s.url.includes("/events"));
  for (const l of expanded) {
    const q = new URL(l.url).searchParams;
    assert.equal(q.get("fields"), "nextPageToken,items(id,status,summary,description,location,start,end,recurringEventId,originalStartTime,extendedProperties)");
    assert.equal(q.get("timeZone"), "Asia/Bangkok");
  }
  const before = seen.length;
  await client.listEvents({ timeZone: "Asia/Bangkok" });
  const plain = seen.slice(before).filter((s) => s.url.includes("/events"));
  for (const l of plain) {
    const q = new URL(l.url).searchParams;
    assert.equal(q.get("fields"), null);
    assert.equal(q.get("timeZone"), "Asia/Bangkok");
  }
});

// ==== step 2 fix round 3: target calendar time zone ====
test("switchPreflight refuses a target zone other than Asia/Bangkok, and a missing one; undefined = not checked", () => {
  const ev = { ...structuredClone(EXTRA) };
  assert.equal(sw.switchPreflight([ev], [], undefined, undefined, "Asia/Bangkok").refusal, null);
  assert.equal(sw.switchPreflight([ev], [], undefined, undefined, "UTC").refusal, sw.TARGET_TIME_ZONE_MESSAGE);
  assert.equal(sw.switchPreflight([ev], [], undefined, undefined, null).refusal, sw.TARGET_TIME_ZONE_UNKNOWN_MESSAGE);
  assert.equal(sw.switchPreflight([ev], []).refusal, null);
  // the zone refusal wins over a plan refusal (the admin can fix it in Google Calendar settings)
  const twin = { ...structuredClone(EXTRA), id: expectRemap(BAD_ID) };
  assert.equal(sw.switchPreflight([BAD_LEGACY, twin], [], undefined, undefined, "UTC").refusal, sw.TARGET_TIME_ZONE_MESSAGE);
});

test("google client: calendarTimeZone reads the events.list top-level timeZone (fields=timeZone); missing → null; errors are fixed text", async () => {
  let body = { timeZone: "Asia/Bangkok", items: [] };
  const { seen, fetchFn } = fakeGoogle(() => (body === "error" ? Response.json({ error: { message: "SYNTH-GOOGLE-TEXT" } }, { status: 403 }) : Response.json(body)));
  const client = sw.createGoogleCalendarClient({ calendarId: "c1", refreshToken: "r" }, { fetch: fetchFn, clientId: "cid", clientSecret: "cs", sleep: async () => {} });
  assert.equal(await client.calendarTimeZone(), "Asia/Bangkok");
  const q = new URL(seen.filter((x) => x.url.includes("/events")).at(-1).url).searchParams;
  assert.equal(q.get("fields"), "timeZone");
  assert.equal(q.get("maxResults"), "1");
  body = { items: [] };
  assert.equal(await client.calendarTimeZone(), null);
  body = { timeZone: 5 };
  assert.equal(await client.calendarTimeZone(), null);
  body = "error";
  await assert.rejects(() => client.calendarTimeZone(), (err) => !String(err.message).includes("SYNTH-GOOGLE-TEXT"));
});
