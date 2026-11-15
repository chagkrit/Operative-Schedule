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
  const st = { data: structuredClone(initial), writes: [], removes: 0, failWriteWhen: null, landThenThrowWhen: null, failReads: 0 };
  const storage = {
    async read() {
      if (st.failReads > 0) {
        st.failReads -= 1;
        throw new Error("SYNTH blob read failed");
      }
      return st.data === "missing" ? "missing" : structuredClone(st.data);
    },
    async write(v) {
      if (st.failWriteWhen && st.failWriteWhen(v, st.writes.length + 1)) throw new Error("SYNTH blob write failed");
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

function harness({ settings = { master: MASTER, candidate: CANDIDATE }, sourceEvents = ALL(), targetEvents = [], envMaster, master = settings.master, advancing = false } = {}) {
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
    },
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

  // re-run completes with no duplicate ids; every id copied by the first run reports "updated"
  // (with 5 concurrent upserts, the ones already in flight when the 3rd failed also landed)
  const copiedFirst = new Set(h.target.events.keys());
  assert.ok(copiedFirst.size >= 2 && copiedFirst.size < 5);
  h.target.failOnUpsert = null;
  const before = h.target.upserts.length;
  const r2 = await sw.runSwitch(h.deps);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const second = h.target.upserts.slice(before);
  for (const u of second) assert.equal(u.result, copiedFirst.has(u.id) ? "updated" : "created", u.id);
  assert.equal(r2.updated, copiedFirst.size);
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
  const h = harness({ sourceEvents: many });
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
  const h = harness({ sourceEvents: many, advancing: true });
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

test("Calendar writes in the app are abandoned within a deadline shorter than SETTLE_MS; reads unchanged", async () => {
  const { readFile } = await import("node:fs/promises");
  const { CALENDAR_WRITE_DEADLINE_MS } = await import("../app/lib/calendar-target.ts");
  assert.ok(CALENDAR_WRITE_DEADLINE_MS <= 30_000);
  assert.ok(CALENDAR_WRITE_DEADLINE_MS + 10_000 <= sw.SETTLE_MS);
  const src = await readFile(new URL("../app/lib/calendar.ts", import.meta.url), "utf8");
  const start = src.indexOf("async function googleFetch(");
  const fn = src.slice(start, src.indexOf("\n}\n", start));
  // the deadline starts before the lock check and covers the fetch; GET gets no signal
  assert.ok(fn.indexOf("AbortSignal.timeout(CALENDAR_WRITE_DEADLINE_MS)") !== -1);
  assert.ok(fn.indexOf("AbortSignal.timeout(CALENDAR_WRITE_DEADLINE_MS)") < fn.indexOf("authorizedAccessToken("));
  assert.match(fn, /=== "GET" \? undefined/);
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
  const h = harness({ sourceEvents: many });
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
