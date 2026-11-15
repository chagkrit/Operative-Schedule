import assert from "node:assert/strict";
import test from "node:test";
import "./ts-resolve.mjs";

const { createCalendarSettingsStore, CALENDAR_SETTINGS_BLOB_PATH, parseSettingsJson } = await import("../app/lib/calendar-settings-store.ts");

const target = (n) => ({ email: `${n}@example.com`, calendarId: `cal-${n}`, sealedRefreshToken: `v1.${n}.x.y` });

function memoryStorage(initial) {
  const s = {
    data: initial,
    writes: [],
    async read() {
      if (s.data instanceof Error) throw s.data;
      return s.data === "missing" ? "missing" : structuredClone(s.data);
    },
    async write(v) {
      if (s.failWrite) throw s.failWrite;
      s.writes.push(structuredClone(v));
      s.data = structuredClone(v);
    },
  };
  return s;
}

test("path constant", () => {
  assert.equal(CALENDAR_SETTINGS_BLOB_PATH, "or-queue/calendar-settings.json");
});

test("first read of absent blob is missing", async () => {
  const store = createCalendarSettingsStore(memoryStorage("missing"));
  assert.equal(await store.read(), "missing");
});

test("storage error propagates, not missing", async () => {
  const store = createCalendarSettingsStore(memoryStorage(new Error("boom")));
  await assert.rejects(() => store.read(), /boom/);
  await assert.rejects(() => store.mutate(() => ({ master: target("a") })), /boom/);
});

test("mutate from missing writes the result", async () => {
  const st = memoryStorage("missing");
  const store = createCalendarSettingsStore(st);
  const r = await store.mutate((cur) => {
    assert.equal(cur, "missing");
    return { master: target("a") };
  });
  assert.deepEqual(r.master, target("a"));
  assert.equal(st.writes.length, 1);
  assert.deepEqual(await store.read(), { master: target("a") });
});

test("stale etag precondition failure surfaces", async () => {
  const st = memoryStorage({ master: target("a") });
  st.failWrite = Object.assign(new Error("precondition"), { name: "BlobPreconditionFailedError" });
  const store = createCalendarSettingsStore(st);
  await assert.rejects(() => store.mutate((s) => ({ ...s, candidate: target("b") })), /precondition/);
  assert.equal(st.writes.length, 0);
});

test("mutate calls are serialized", async () => {
  const st = memoryStorage({ master: target("a") });
  const store = createCalendarSettingsStore(st);
  await Promise.all([
    store.mutate((s) => ({ ...s, candidate: target("b") })),
    store.mutate((s) => ({ ...s, lock: { since: 1, by: "x" } })),
  ]);
  const final = await store.read();
  assert.ok(final.candidate && final.lock);
});

test("parseSettingsJson validates shape", () => {
  assert.deepEqual(parseSettingsJson(JSON.stringify({ master: target("a") })), { master: target("a") });
  // a file without master (candidate and/or lock only) is valid: the env master applies
  assert.deepEqual(parseSettingsJson(JSON.stringify({ candidate: target("c") })), { candidate: target("c") });
  assert.deepEqual(parseSettingsJson(JSON.stringify({ lock: { since: 1, by: "x" } })), { lock: { since: 1, by: "x" } });
  assert.throws(() => parseSettingsJson(JSON.stringify({ candidate: { email: "a" } })));
  assert.throws(() => parseSettingsJson("[]"));
  assert.throws(() => parseSettingsJson("{}"));
  assert.throws(() => parseSettingsJson(JSON.stringify({ master: { email: "a" } })));
  assert.throws(() => parseSettingsJson("not json"));
});

// ---- 30 s success-only read cache (fake clock + counting storage) ----
function counting(initial) {
  const st = memoryStorage(initial);
  const realRead = st.read;
  st.reads = 0;
  st.read = async () => { st.reads += 1; return realRead(); };
  return st;
}
const clock = () => { const c = { t: 1_000_000, now: () => c.t }; return c; };

test("two cached reads within the TTL hit storage once", async () => {
  const st = counting({ master: target("a") }); const c = clock();
  const store = createCalendarSettingsStore(st, c.now);
  await store.read({ allowCached: true }); c.t += 29_000;
  assert.deepEqual(await store.read({ allowCached: true }), { master: target("a") });
  assert.equal(st.reads, 1);
});

test("default read is always fresh", async () => {
  const st = counting({ master: target("a") }); const c = clock();
  const store = createCalendarSettingsStore(st, c.now);
  await store.read({ allowCached: true }); await store.read(); await store.read();
  assert.equal(st.reads, 3);
});

test("after the TTL a throwing read rejects even though a value was cached", async () => {
  const st = counting({ master: target("a") }); const c = clock();
  const store = createCalendarSettingsStore(st, c.now);
  await store.read({ allowCached: true });
  st.data = new Error("blob down"); c.t += 30_001;
  await assert.rejects(() => store.read({ allowCached: true }), /blob down/);
});

test("errors are never cached: the next call retries storage", async () => {
  const st = counting(new Error("boom")); const c = clock();
  const store = createCalendarSettingsStore(st, c.now);
  await assert.rejects(() => store.read({ allowCached: true }), /boom/);
  st.data = { master: target("a") };
  assert.deepEqual(await store.read({ allowCached: true }), { master: target("a") });
  assert.equal(st.reads, 2);
});

test('"missing" is cached for cached reads', async () => {
  const st = counting("missing"); const c = clock();
  const store = createCalendarSettingsStore(st, c.now);
  assert.equal(await store.read({ allowCached: true }), "missing");
  assert.equal(await store.read({ allowCached: true }), "missing");
  assert.equal(st.reads, 1);
});

test("a fresh read sees a lock written after the cache was filled and refreshes the cache", async () => {
  const st = counting({ master: target("a") }); const c = clock();
  const store = createCalendarSettingsStore(st, c.now);
  await store.read({ allowCached: true });
  st.data = { master: target("a"), lock: { since: c.t, by: "x@example.com" } };
  assert.equal((await store.read({ allowCached: true })).lock, undefined); // stale within TTL
  assert.ok((await store.read()).lock); // fresh read sees it
  assert.ok((await store.read({ allowCached: true })).lock); // and cache now holds it
});

test("mutate replaces the cache with the written value", async () => {
  const st = counting({ master: target("a") }); const c = clock();
  const store = createCalendarSettingsStore(st, c.now);
  await store.read({ allowCached: true });
  await store.mutate((s) => ({ ...s, candidate: target("b") }));
  const before = st.reads;
  assert.deepEqual((await store.read({ allowCached: true })).candidate, target("b"));
  assert.equal(st.reads, before);
});

test("a slower earlier read cannot overwrite a newer cache", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const st = memoryStorage({ master: target("old") });
  const realRead = st.read; let first = true;
  st.read = async () => { const v = await realRead(); if (first) { first = false; await gate; } return v; };
  const store = createCalendarSettingsStore(st, clock().now);
  const slow = store.read({ allowCached: true });
  await store.mutate(() => ({ master: target("new") }));
  release(); await slow;
  assert.equal((await store.read({ allowCached: true })).master.calendarId, "cal-new");
});

// Deferred storage: each read resolves only when the test releases it.
function deferredStorage() {
  const pending = [];
  return {
    pending,
    read() { return new Promise((resolve) => pending.push(resolve)); },
    async write() {},
  };
}

test("read-vs-read race: a slow earlier read cannot overwrite a newer read's cache", async () => {
  const st = deferredStorage(); const c = clock();
  const store = createCalendarSettingsStore(st, c.now);
  const slow = store.read({ allowCached: true }); // storage returns "old" later
  const fresh = store.read(); // newer read
  st.pending[1]({ master: target("new") });
  assert.equal((await fresh).master.calendarId, "cal-new");
  st.pending[0]({ master: target("old") }); // slow read completes last
  assert.equal((await slow).master.calendarId, "cal-old"); // still returns its own value
  c.t += 29_000;
  assert.equal((await store.read({ allowCached: true })).master.calendarId, "cal-new");
  assert.equal(st.pending.length, 2); // served from cache, no third storage read
});

test("cache expiry is measured from when the read started", async () => {
  const st = deferredStorage(); const c = clock();
  const store = createCalendarSettingsStore(st, c.now);
  const p = store.read({ allowCached: true });
  c.t += 20_000; // read takes 20 s
  st.pending[0]({ master: target("a") });
  await p;
  c.t += 9_000; // 29 s after start: still cached
  await store.read({ allowCached: true });
  assert.equal(st.pending.length, 1);
  c.t += 2_000; // 31 s after start (11 s after completion): expired
  const again = store.read({ allowCached: true });
  assert.equal(st.pending.length, 2);
  st.pending[1]({ master: target("a") });
  await again;
});

// ---- never write an empty {} file: "missing" deletes, invalid values are refused ----
function removable(initial) {
  const st = memoryStorage(initial);
  st.removes = 0;
  st.remove = async () => {
    if (st.failRemove) throw st.failRemove;
    st.removes += 1;
    st.data = "missing";
  };
  return st;
}

test('mutate returning "missing" on an existing file deletes the blob instead of writing {}', async () => {
  const st = removable({ lock: { since: 1, by: "x" } });
  const store = createCalendarSettingsStore(st, clock().now);
  const r = await store.mutate(() => "missing");
  assert.equal(r, "missing");
  assert.equal(st.removes, 1);
  assert.equal(st.writes.length, 0);
  assert.equal(st.data, "missing");
  assert.equal(await store.read({ allowCached: true }), "missing");
});

test('mutate returning "missing" when the file is already missing touches nothing', async () => {
  const st = removable("missing");
  const store = createCalendarSettingsStore(st);
  assert.equal(await store.mutate(() => "missing"), "missing");
  assert.equal(st.removes, 0);
  assert.equal(st.writes.length, 0);
});

test("mutate refuses to write a value parseSettingsJson would reject (e.g. {})", async () => {
  const st = removable({ lock: { since: 1, by: "x" } });
  const store = createCalendarSettingsStore(st);
  await assert.rejects(() => store.mutate(() => ({})));
  await assert.rejects(() => store.mutate(() => ({ master: { email: "a" } })));
  assert.equal(st.writes.length, 0);
  assert.equal(st.removes, 0);
  assert.deepEqual(st.data, { lock: { since: 1, by: "x" } });
});

test("a failing delete propagates and leaves the cache as it was", async () => {
  const st = removable({ lock: { since: 1, by: "x" } });
  st.failRemove = new Error("del failed");
  const store = createCalendarSettingsStore(st);
  await assert.rejects(() => store.mutate(() => "missing"), /del failed/);
  assert.deepEqual(st.data, { lock: { since: 1, by: "x" } });
});

test("blob delete is conditional on the etag of the last read (never an unconditional delete)", async () => {
  const { blobDeleteOptions } = await import("../app/lib/user-store.ts");
  const opts = blobDeleteOptions("etag-1");
  assert.equal(opts.ifMatch, "etag-1");
  assert.throws(() => blobDeleteOptions(null));
  assert.throws(() => blobDeleteOptions(""));
});

test("parseSettingsJson: a corrupt file throws a FIXED message that quotes no part of the file (sealed token safe)", () => {
  const secret = "xv1.SEALED-SECRET-abc.def.ghi";
  for (const text of [secret, `{"master": ${secret}}`, `{"master":{"sealedRefreshToken":"v1.SEALED-SECRET-abc"`]) {
    let caught;
    try {
      parseSettingsJson(text);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "must throw");
    // V8's SyntaxError quotes up to ~10 characters of the input: no 5-character window of it may appear
    for (const where of [String(caught.message), String(caught.stack ?? "")]) {
      for (let i = 0; i + 5 <= text.length; i += 1) {
        const window = text.slice(i, i + 5);
        if (/^[\s{}":,]+$/.test(window)) continue;
        assert.ok(!where.includes(window), `error quotes the file: ${JSON.stringify(window)}`);
      }
    }
    assert.equal(caught.cause, undefined, "the SyntaxError (which quotes the file) is not attached");
    assert.equal(caught.message, "calendar-settings.json is not valid JSON");
  }
});
