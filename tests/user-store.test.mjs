import assert from "node:assert/strict";
import test from "node:test";
import "./ts-resolve.mjs";
import { BOOTSTRAP_ADMIN, SEED_USERS, addUser, removeUser } from "../app/lib/users.ts";

// Dynamic import so the ts-resolve hook is active when user-store.ts resolves "./users".
const {
  BLOB_TIMEOUT_MS,
  CACHE_TTL_MS,
  USERS_BLOB_PATH,
  blobPutOptions,
  blobTimeoutSignal,
  createUserStore,
  parseUsersJson,
  storageReadKind,
} = await import("../app/lib/user-store.ts");

const u = (email, role = "user", active = true) => ({ email, role, active });
const ADMIN = BOOTSTRAP_ADMIN;
const HN = "hnbcmu@gmail.com";
const ALLOWED_ADMIN = { allowed: true, role: "admin" };
const ALLOWED_USER = { allowed: true, role: "user" };
const DENIED = { allowed: false, role: null };

// In-memory adapter: `data` is the stored list, "missing" (404) or an Error (read throws).
function memoryStorage(initial) {
  const s = {
    data: initial,
    reads: 0,
    writes: [],
    async read() {
      s.reads += 1;
      if (s.data instanceof Error) throw s.data;
      return s.data === "missing" ? "missing" : structuredClone(s.data);
    },
    async write(users) {
      s.writes.push(structuredClone(users));
      s.data = structuredClone(users);
    },
  };
  return s;
}

function fakeClock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

function silenceErrors(t) {
  t.mock.method(console, "error", () => {});
}

test("constants: blob path and 30 s cache", () => {
  assert.equal(USERS_BLOB_PATH, "or-queue/users.json");
  assert.equal(CACHE_TTL_MS, 30_000);
});

test("missing list (404) is seeded once and then served", async () => {
  const storage = memoryStorage("missing");
  const store = createUserStore(storage, fakeClock().now);
  assert.deepEqual(await store.getAccess(HN), ALLOWED_USER);
  assert.deepEqual(await store.getAccess(ADMIN), ALLOWED_ADMIN);
  assert.deepEqual(storage.writes, [SEED_USERS]);
  assert.equal(storage.reads, 1);
});

test("concurrent cold reads share one load (one seed write)", async () => {
  const storage = memoryStorage("missing");
  const store = createUserStore(storage, fakeClock().now);
  const results = await Promise.all([store.getAccess(HN), store.getAccess("x@y.com"), store.list()]);
  assert.deepEqual(results[0], ALLOWED_USER);
  assert.deepEqual(results[1], DENIED);
  assert.equal(storage.writes.length, 1);
});

test("an existing empty list is NOT reseeded: only the bootstrap admin remains", async () => {
  const storage = memoryStorage([]);
  const store = createUserStore(storage, fakeClock().now);
  assert.deepEqual(await store.getAccess(HN), DENIED);
  assert.deepEqual(await store.getAccess(ADMIN), ALLOWED_ADMIN);
  assert.deepEqual(await store.list(), [u(ADMIN, "admin")]);
  assert.equal(storage.writes.length, 0);
});

test("read error: non-bootstrap denied, bootstrap allowed, nothing written", async (t) => {
  silenceErrors(t);
  const storage = memoryStorage(new Error("blob 500"));
  const store = createUserStore(storage, fakeClock().now);
  assert.deepEqual(await store.getAccess(HN), DENIED);
  assert.deepEqual(await store.getAccess(" NANSURG7@gmail.com "), ALLOWED_ADMIN);
  assert.equal(storage.writes.length, 0);
  await assert.rejects(store.list(), /blob 500/);
  await assert.rejects(store.mutate((list) => addUser(list, "a@x.com", "user")), /blob 500/);
  assert.equal(storage.writes.length, 0);
});

test("a corrupt file is logged by error name only: no email text reaches the console", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args.map(String).join(" ")));
  const storage = memoryStorage([]);
  // A real JSON.parse error quotes the file content, which can contain emails.
  storage.read = async () => parseUsersJson("secret.person@x.com, hnbcmu@gmail.com");
  const store = createUserStore(storage, fakeClock().now);
  assert.deepEqual(await store.getAccess(HN), DENIED);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /SyntaxError/);
  assert.doesNotMatch(logged[0], /@|secret|hnbcmu/);
  assert.equal(storage.writes.length, 0);
});

test("a Blob timeout (aborted read or write) fails closed: nothing cached, nothing written", async (t) => {
  silenceErrors(t);
  const aborted = () => new DOMException("This operation was aborted", "AbortError");
  const storage = memoryStorage(aborted());
  const store = createUserStore(storage, fakeClock().now);
  assert.deepEqual(await store.getAccess(HN), DENIED);
  assert.deepEqual(await store.getAccess(ADMIN), ALLOWED_ADMIN);
  await assert.rejects(store.mutate((list) => addUser(list, "a@x.com", "user")), { name: "AbortError" });
  assert.equal(storage.writes.length, 0);
  storage.data = [u(HN)]; // the next read works: the timeout was not cached
  assert.deepEqual(await store.getAccess(HN), ALLOWED_USER);
  storage.write = async () => {
    throw aborted();
  };
  await assert.rejects(store.mutate((list) => removeUser(list, HN, ADMIN)), { name: "AbortError" });
  storage.data = [u(HN, "user", false)];
  assert.deepEqual(await store.getAccess(HN), DENIED); // cache dropped after the failed write
});

test("blobTimeoutSignal: 5 s, aborts with an AbortError (the Blob SDK retries a TimeoutError with backoff)", async () => {
  assert.equal(BLOB_TIMEOUT_MS, 5_000);
  const signal = blobTimeoutSignal(10);
  assert.equal(signal.aborted, false);
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, "AbortError");
});

test("read errors are not cached: recovery is picked up on the next call", async (t) => {
  silenceErrors(t);
  const storage = memoryStorage(new Error("down"));
  const store = createUserStore(storage, fakeClock().now);
  assert.deepEqual(await store.getAccess(HN), DENIED);
  storage.data = [u(HN)];
  assert.deepEqual(await store.getAccess(HN), ALLOWED_USER);
});

test("cache is used for 30 s, then the list is re-read", async () => {
  const clock = fakeClock();
  const storage = memoryStorage([u(HN)]);
  const store = createUserStore(storage, clock.now);
  assert.deepEqual(await store.getAccess(HN), ALLOWED_USER);
  storage.data = [u(HN, "user", false)]; // changed by another instance
  clock.t += CACHE_TTL_MS - 1;
  assert.deepEqual(await store.getAccess(HN), ALLOWED_USER);
  assert.equal(storage.reads, 1);
  clock.t += 1;
  assert.deepEqual(await store.getAccess(HN), DENIED);
  assert.equal(storage.reads, 2);
});

test("expired cache is not served when the re-read fails (fail closed)", async (t) => {
  silenceErrors(t);
  const clock = fakeClock();
  const storage = memoryStorage([u(HN)]);
  const store = createUserStore(storage, clock.now);
  assert.deepEqual(await store.getAccess(HN), ALLOWED_USER);
  storage.data = new Error("down");
  clock.t += CACHE_TTL_MS;
  assert.deepEqual(await store.getAccess(HN), DENIED);
  assert.deepEqual(await store.getAccess(ADMIN), ALLOWED_ADMIN);
});

test("mutate reads fresh (bypasses cache), writes, and refreshes the cache", async () => {
  const clock = fakeClock();
  const storage = memoryStorage([u(HN)]);
  const store = createUserStore(storage, clock.now);
  assert.deepEqual(await store.getAccess("new@x.com"), DENIED); // cache now holds [ADMIN, HN]
  storage.data = [u(HN), u("other@x.com")]; // another instance added a user
  const result = await store.mutate((list) => addUser(list, "new@x.com", "user"));
  assert.equal(result.ok, true);
  assert.equal(storage.reads, 2);
  assert.deepEqual(storage.writes.at(-1), [u(ADMIN, "admin"), u(HN), u("other@x.com"), u("new@x.com")]);
  assert.deepEqual(result.users, storage.writes.at(-1));
  // No TTL wait needed: the local cache was invalidated by the write.
  assert.deepEqual(await store.getAccess("new@x.com"), ALLOWED_USER);
  assert.deepEqual(await store.getAccess("other@x.com"), ALLOWED_USER);
  assert.equal(storage.reads, 2);
});

test("mutate removal takes effect immediately on this instance", async () => {
  const storage = memoryStorage([u(HN)]);
  const store = createUserStore(storage, fakeClock().now);
  assert.deepEqual(await store.getAccess(HN), ALLOWED_USER);
  const result = await store.mutate((list) => removeUser(list, HN, ADMIN));
  assert.equal(result.ok, true);
  assert.deepEqual(await store.getAccess(HN), DENIED);
});

test("failed mutate returns the Thai error and does not write", async () => {
  const storage = memoryStorage([u(HN)]);
  const store = createUserStore(storage, fakeClock().now);
  const result = await store.mutate((list) => addUser(list, "abc", "user"));
  assert.equal(result.ok, false);
  assert.match(result.error, /อีเมล/);
  assert.equal(storage.writes.length, 0);
});

test("bootstrap admin is injected into reads, into fn's list, and before writing", async () => {
  const storage = memoryStorage([u(HN), u("boss@x.com", "admin")]); // stored list lacks nansurg7
  const store = createUserStore(storage, fakeClock().now);
  assert.deepEqual(await store.list(), [u(ADMIN, "admin"), u(HN), u("boss@x.com", "admin")]);
  let seen;
  const result = await store.mutate((list) => {
    seen = list;
    return { ok: true, users: [u(HN)] }; // drops both admins
  });
  assert.deepEqual(seen, [u(ADMIN, "admin"), u(HN), u("boss@x.com", "admin")]);
  assert.equal(result.ok, true);
  assert.deepEqual(storage.writes.at(-1), [u(ADMIN, "admin"), u(HN)]);
});

test("last-admin guard sees the bootstrap admin, so removing another admin works", async () => {
  const storage = memoryStorage([u("boss@x.com", "admin")]);
  const store = createUserStore(storage, fakeClock().now);
  const result = await store.mutate((list) => removeUser(list, "boss@x.com", ADMIN));
  assert.equal(result.ok, true);
  assert.deepEqual(storage.writes.at(-1), [u(ADMIN, "admin")]);
});

test("mutate on a missing list seeds first, then applies the change", async () => {
  const storage = memoryStorage("missing");
  const store = createUserStore(storage, fakeClock().now);
  const result = await store.mutate((list) => addUser(list, "a@x.com", "user"));
  assert.equal(result.ok, true);
  assert.deepEqual(storage.writes, [SEED_USERS, [...SEED_USERS, u("a@x.com")]]);
});

test("write failure rejects mutate and leaves the cache to re-read", async () => {
  const storage = memoryStorage([u(HN)]);
  const store = createUserStore(storage, fakeClock().now);
  assert.deepEqual(await store.getAccess(HN), ALLOWED_USER);
  storage.write = async () => {
    throw new Error("precondition failed");
  };
  await assert.rejects(store.mutate((list) => removeUser(list, HN, ADMIN)), /precondition failed/);
  storage.data = [u(HN, "user", false)];
  assert.deepEqual(await store.getAccess(HN), DENIED); // cache was dropped, re-read happened
});

test("a read in flight before a mutate cannot overwrite the newer cache", async () => {
  const storage = memoryStorage([u(HN)]);
  const store = createUserStore(storage, fakeClock().now);
  let release;
  const realRead = storage.read;
  storage.read = () =>
    new Promise((resolve) => {
      release = () => resolve([u(HN)]); // stale snapshot
    });
  const stale = store.getAccess(HN);
  storage.read = realRead;
  const result = await store.mutate((list) => removeUser(list, HN, ADMIN));
  assert.equal(result.ok, true);
  release();
  assert.deepEqual(await stale, ALLOWED_USER); // that request saw the old list
  assert.deepEqual(await store.getAccess(HN), DENIED); // but the cache keeps the mutated list
});

test("mutates are serialized: concurrent adds both survive", async () => {
  const storage = memoryStorage([]);
  const store = createUserStore(storage, fakeClock().now);
  const [a, b] = await Promise.all([
    store.mutate((list) => addUser(list, "a@x.com", "user")),
    store.mutate((list) => addUser(list, "b@x.com", "admin")),
  ]);
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(storage.data, [u(ADMIN, "admin"), u("a@x.com"), u("b@x.com", "admin")]);
});

test("a throwing mutate does not block later mutates", async () => {
  const storage = memoryStorage([]);
  const store = createUserStore(storage, fakeClock().now);
  await assert.rejects(
    store.mutate(() => {
      throw new Error("boom");
    }),
    /boom/,
  );
  const ok = await store.mutate((list) => addUser(list, "a@x.com", "user"));
  assert.equal(ok.ok, true);
});

test("list returns copies: editing them does not change the cache", async () => {
  const storage = memoryStorage([u(HN)]);
  const store = createUserStore(storage, fakeClock().now);
  const list = await store.list();
  list[1].active = false;
  list.push(u("evil@x.com", "admin"));
  assert.deepEqual(await store.getAccess(HN), ALLOWED_USER);
  assert.deepEqual(await store.getAccess("evil@x.com"), DENIED);
});

test("parseUsersJson: valid arrays load; corrupt or wrong-shape content throws", () => {
  assert.deepEqual(parseUsersJson("[]"), []);
  assert.deepEqual(parseUsersJson(JSON.stringify([u(HN), u("b@x.com", "admin", false)])), [
    u(HN),
    u("b@x.com", "admin", false),
  ]);
  for (const bad of ["", "{", "null", "{}", '"text"', "[1]", "[null]", '[{"role":"user"}]', '[{"email":5}]']) {
    assert.throws(() => parseUsersJson(bad), Error, bad);
  }
});

test("storageReadKind: only a null get() result means missing", () => {
  assert.equal(storageReadKind(null), "missing");
  assert.equal(storageReadKind({ statusCode: 200, stream: {}, blob: { etag: '"e1"' } }), "found");
  assert.throws(() => storageReadKind({ statusCode: 304, stream: null, blob: { etag: '"e1"' } }));
  assert.throws(() => storageReadKind(undefined));
});

test("blobPutOptions: private, fixed path; create-only without etag, ifMatch with etag", () => {
  const create = blobPutOptions(null);
  assert.equal(create.access, "private");
  assert.equal(create.addRandomSuffix, false);
  assert.equal(create.allowOverwrite, false);
  assert.equal("ifMatch" in create, false);
  const update = blobPutOptions('"etag-1"');
  assert.equal(update.access, "private");
  assert.equal(update.addRandomSuffix, false);
  assert.equal(update.ifMatch, '"etag-1"');
  assert.equal(update.contentType, "application/json");
});
