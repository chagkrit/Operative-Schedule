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
};

export const SETTINGS_CACHE_TTL_MS = 30_000;

export type CalendarSettingsStore = {
  read(opts?: { allowCached?: boolean }): Promise<CalendarSettings | "missing">;
  mutate(fn: (s: CalendarSettings | "missing") => CalendarSettings): Promise<CalendarSettings>;
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

// A corrupt or wrong-shape file throws; it never counts as missing.
export function parseSettingsJson(text: string): CalendarSettings {
  const data: unknown = JSON.parse(text);
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
    mutate(fn) {
      const run = async (): Promise<CalendarSettings> => {
        const next = fn(await storage.read());
        await storage.write(next);
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
