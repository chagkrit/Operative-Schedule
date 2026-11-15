// SERVER-ONLY: the master-calendar settings store (one private Blob JSON file). Holds sealed
// refresh tokens; never log its contents. Reads are fresh by default; callers doing GET reads may
// opt into a 30 s success-only cache ({ allowCached: true }). Errors are never cached and writes always
// read fresh, so a stale master can never receive a write. Failure policy mirrors user-store.ts:
// "missing" only for a true 404; every other failure throws.
import { BLOB_TIMEOUT_MS, blobJsonStorage, UserStoreError } from "./user-store";
import type { CalendarSettings, CalendarTarget } from "./calendar-settings";

export const CALENDAR_SETTINGS_BLOB_PATH = "or-queue/calendar-settings.json";
export { BLOB_TIMEOUT_MS };

export type CalendarSettingsStorage = {
  read(): Promise<CalendarSettings | "missing">;
  write(settings: CalendarSettings): Promise<void>;
  // Deletes the file (etag-conditional in the Blob adapter). Called only when a mutate yields "missing".
  remove(): Promise<void>;
};

export const SETTINGS_CACHE_TTL_MS = 30_000;

export type CalendarSettingsStore = {
  read(opts?: { allowCached?: boolean }): Promise<CalendarSettings | "missing">;
  // fn may return "missing" to mean "no settings file" (the file is deleted, never written as {}).
  mutate(fn: (s: CalendarSettings | "missing") => CalendarSettings | "missing"): Promise<CalendarSettings | "missing">;
};

function parseTarget(v: unknown, label: string): CalendarTarget {
  const t = v as Partial<CalendarTarget> | null;
  if (
    !t || typeof t !== "object" ||
    typeof t.email !== "string" || typeof t.calendarId !== "string" || typeof t.sealedRefreshToken !== "string"
  ) {
    throw new UserStoreError(`calendar-settings.json ${label} is malformed`);
  }
  return { email: t.email, calendarId: t.calendarId, sealedRefreshToken: t.sealedRefreshToken };
}

// A corrupt or wrong-shape file throws; it never counts as missing. A JSON SyntaxError quotes part of the
// file (which holds sealed tokens), so it is replaced by a fixed message and never attached as a cause.
export function parseSettingsJson(text: string): CalendarSettings {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UserStoreError("calendar-settings.json is not valid JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new UserStoreError("calendar-settings.json is not an object");
  }
  const d = data as { master?: unknown; previousMaster?: unknown; candidate?: unknown; lock?: unknown };
  const out: CalendarSettings = {};
  if (d.master !== undefined) out.master = parseTarget(d.master, "master");
  if (d.previousMaster !== undefined) out.previousMaster = parseTarget(d.previousMaster, "previousMaster");
  if (d.candidate !== undefined) out.candidate = parseTarget(d.candidate, "candidate");
  if (d.lock !== undefined) {
    const l = d.lock as { since?: unknown; by?: unknown } | null;
    if (!l || typeof l.since !== "number" || typeof l.by !== "string") {
      throw new UserStoreError("calendar-settings.json lock is malformed");
    }
    out.lock = { since: l.since, by: l.by };
  }
  // An empty object is corrupt, not "env applies": fail closed rather than silently falling back.
  if (!out.master && !out.previousMaster && !out.candidate && !out.lock) {
    throw new UserStoreError("calendar-settings.json has no master, candidate or lock");
  }
  return out;
}

export function createCalendarSettingsStore(
  storage: CalendarSettingsStorage,
  now: () => number = Date.now,
): CalendarSettingsStore {
  let queue: Promise<unknown> = Promise.resolve();
  let cache: { value: CalendarSettings | "missing"; at: number } | null = null;
  let generation = 0;
  const setCache = (value: CalendarSettings | "missing", at: number) => {
    cache = { value, at };
  };
  return {
    read(opts) {
      if (opts?.allowCached && cache && now() - cache.at < SETTINGS_CACHE_TTL_MS) return Promise.resolve(cache.value);
      // Every read takes a new generation; only the newest one may fill the cache, and its age is
      // measured from when the read STARTED. A superseded read still returns its own value to its caller.
      const g = ++generation;
      const startedAtMs = now();
      // Only successes are cached; a rejection propagates and leaves the cache as it was.
      return storage.read().then((value) => {
        if (generation === g) setCache(value, startedAtMs);
        return value;
      });
    },
    // Serialized per instance: fresh read -> fn -> etag-guarded write. A write failure
    // (including a stale-etag precondition failure) propagates. The cache is replaced with what was written.
    // A "missing" result deletes the file (nothing to do when it is already missing); a value the parser
    // would reject (e.g. {}) is refused before anything is written, so a write can never brick later reads.
    mutate(fn) {
      const run = async (): Promise<CalendarSettings | "missing"> => {
        const current = await storage.read();
        const next = fn(current);
        if (next === "missing") {
          if (current !== "missing") await storage.remove();
        } else {
          parseSettingsJson(JSON.stringify(next));
          await storage.write(next);
        }
        generation += 1;
        setCache(next, now());
        return next;
      };
      const p = queue.then(run, run);
      queue = p.catch(() => undefined);
      return p;
    },
  };
}

// ---- Vercel Blob adapter (shared with the users store) -------------------------------
export function blobSettingsStorage(pathname: string = CALENDAR_SETTINGS_BLOB_PATH): CalendarSettingsStorage {
  return blobJsonStorage<CalendarSettings>(pathname, parseSettingsJson, (v) => JSON.stringify(v, null, 2));
}

export const calendarSettingsStore: CalendarSettingsStore = createCalendarSettingsStore(blobSettingsStorage());
