// SERVER-ONLY: the email allowlist store. Never import this from a client component
// (it holds the Blob token path and the list of emails).
//
// The list lives in one private Vercel Blob JSON file. Reads are cached in memory for
// CACHE_TTL_MS so a removed/deactivated user loses access within ~30 s; writes through
// `mutate` refresh this instance's cache at once. Failure policy:
// - storage.read() returns "missing" (HTTP 404) ⇒ write SEED_USERS (create-only) and use it;
// - storage.read() throws (any other error, corrupt JSON) ⇒ fail closed for everyone except
//   the bootstrap admin; nothing is written and nothing is cached.
import {
  BOOTSTRAP_ADMIN,
  SEED_USERS,
  findAccess,
  normalizeEmail,
  withBootstrap,
  type Access,
  type Result,
  type UserRecord,
} from "./users";

export const USERS_BLOB_PATH = "or-queue/users.json";
export const CACHE_TTL_MS = 30_000;

// read() resolves "missing" only for a 404 and throws on every other error.
export type UserStorage = {
  read(): Promise<UserRecord[] | "missing">;
  write(users: UserRecord[]): Promise<void>;
};

export type UserStore = {
  getAccess(email: string): Promise<Access>;
  list(): Promise<UserRecord[]>;
  mutate(fn: (list: UserRecord[]) => Result): Promise<Result>;
};

function copyList(list: readonly UserRecord[]): UserRecord[] {
  return list.map((r) => ({ email: r.email, role: r.role, active: r.active }));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createUserStore(storage: UserStorage, now: () => number = Date.now): UserStore {
  let cache: { users: UserRecord[]; at: number } | null = null;
  // Bumped whenever the cache is replaced or dropped, so a read that started earlier
  // cannot overwrite a newer cache when it finishes.
  let generation = 0;
  let inflight: Promise<UserRecord[]> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function setCache(users: UserRecord[] | null) {
    generation += 1;
    cache = users ? { users, at: now() } : null;
  }

  // Reads storage (no cache), seeding only when the file is missing.
  async function loadFresh(): Promise<UserRecord[]> {
    const stored = await storage.read();
    if (stored === "missing") {
      const seeded = withBootstrap(SEED_USERS);
      await storage.write(copyList(seeded));
      return seeded;
    }
    return withBootstrap(stored);
  }

  function refresh(): Promise<UserRecord[]> {
    if (!inflight) {
      const startedAt = generation;
      const load = loadFresh().then((users) => {
        if (generation === startedAt) setCache(users);
        return users;
      });
      inflight = load;
      load.then(
        () => {
          if (inflight === load) inflight = null;
        },
        () => {
          if (inflight === load) inflight = null;
        },
      );
    }
    return inflight;
  }

  function current(): Promise<UserRecord[]> {
    if (cache && now() - cache.at < CACHE_TTL_MS) return Promise.resolve(cache.users);
    return refresh();
  }

  return {
    async getAccess(email) {
      try {
        return findAccess(await current(), email);
      } catch (err) {
        console.error("[user-store] user list unreadable; access fails closed:", errorMessage(err));
        if (normalizeEmail(email) === BOOTSTRAP_ADMIN) return { allowed: true, role: "admin" };
        return { allowed: false, role: null };
      }
    },

    // Admin view: always a fresh read (also refreshes the cache). Throws when storage fails.
    async list() {
      return copyList(await refresh());
    },

    // Serialized per instance: fresh read → fn → write → cache. A rejected Result writes nothing.
    mutate(fn) {
      const run = async (): Promise<Result> => {
        inflight = null; // never reuse a read that started before this mutate
        const users = await loadFresh();
        const result = fn(copyList(users));
        if (!result.ok) {
          setCache(users);
          return result;
        }
        const next = withBootstrap(result.users);
        try {
          await storage.write(copyList(next));
        } catch (err) {
          setCache(null);
          throw err;
        }
        setCache(next);
        return { ok: true, users: copyList(next) };
      };
      const p = queue.then(run, run);
      queue = p.catch(() => undefined);
      return p;
    },
  };
}

// ---- Vercel Blob adapter -------------------------------------------------------------
// Token: BLOB_READ_WRITE_TOKEN (or VERCEL_OIDC_TOKEN + BLOB_STORE_ID), read by the SDK.

// Content of the blob file. A corrupt or wrong-shape file throws (fail closed), it never
// counts as missing and is never reseeded.
export function parseUsersJson(text: string): UserRecord[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("users.json is not an array");
  return data.map((item: unknown, i) => {
    if (!item || typeof item !== "object" || typeof (item as { email?: unknown }).email !== "string") {
      throw new Error(`users.json item ${i} has no email`);
    }
    const r = item as { email: string; role?: unknown; active?: unknown };
    return { email: r.email, role: r.role as UserRecord["role"], active: r.active as boolean };
  });
}

// `get()` from @vercel/blob resolves null for 404 and throws for every other failure,
// so only null means "missing". Anything that is not a full 200 response is an error.
export function storageReadKind(result: { statusCode: number } | null | undefined): "missing" | "found" {
  if (result === null) return "missing";
  if (!result || result.statusCode !== 200) {
    throw new Error(`unexpected blob read result: ${result ? result.statusCode : String(result)}`);
  }
  return "found";
}

// Without a known etag the write is create-only (allowOverwrite false), so a seed can
// never replace an existing list; with an etag it is a conditional overwrite (ifMatch).
export function blobPutOptions(etag: string | null) {
  const base = {
    access: "private" as const,
    addRandomSuffix: false,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  };
  return etag ? { ...base, ifMatch: etag } : { ...base, allowOverwrite: false };
}

// Keeps the etag of the last read/write. Known limit: a cache refresh that lands between a
// mutate's read and write advances this etag, so a write by another instance in that gap
// could be overwritten (single admin in practice).
export function blobStorage(pathname: string = USERS_BLOB_PATH): UserStorage {
  let etag: string | null = null;
  return {
    async read() {
      const { get } = await import("@vercel/blob");
      const result = await get(pathname, { access: "private", useCache: false });
      if (storageReadKind(result) === "missing") {
        etag = null;
        return "missing";
      }
      if (!result || result.statusCode !== 200) throw new Error("unexpected blob read result"); // narrows the type
      const text = await new Response(result.stream as unknown as ReadableStream<Uint8Array>).text();
      const users = parseUsersJson(text);
      etag = result.blob.etag || null;
      return users;
    },
    async write(users) {
      // Options first, synchronously: the etag must be the one current when write() was called,
      // not one a concurrent read() sets while the SDK import is awaited (a seed must stay create-only).
      const opts = blobPutOptions(etag);
      const { put } = await import("@vercel/blob");
      const saved = await put(pathname, JSON.stringify(users, null, 2), opts);
      etag = saved.etag || null;
    },
  };
}

export const userStore: UserStore = createUserStore(blobStorage());
