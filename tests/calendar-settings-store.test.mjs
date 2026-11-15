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
  assert.throws(() => parseSettingsJson("[]"));
  assert.throws(() => parseSettingsJson("{}"));
  assert.throws(() => parseSettingsJson(JSON.stringify({ master: { email: "a" } })));
  assert.throws(() => parseSettingsJson("not json"));
});
