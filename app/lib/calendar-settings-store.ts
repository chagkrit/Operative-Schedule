// SERVER-ONLY: the master-calendar settings store (one private Blob JSON file). Holds sealed
// refresh tokens; never log its contents. Reads are never cached (settings change rarely and a
// stale master would write to the wrong calendar). Failure policy mirrors user-store.ts:
// "missing" only for a true 404; every other failure throws.
import { BLOB_TIMEOUT_MS, blobJsonStorage, UserStoreError } from "./user-store";
import type { CalendarSettings, CalendarTarget } from "./calendar-settings";

export const CALENDAR_SETTINGS_BLOB_PATH = "or-queue/calendar-settings.json";
export { BLOB_TIMEOUT_MS };

export type CalendarSettingsStorage = {
  read(): Promise<CalendarSettings | "missing">;
  write(settings: CalendarSettings): Promise<void>;
};

export type CalendarSettingsStore = {
  read(): Promise<CalendarSettings | "missing">;
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
  const out: CalendarSettings = { master: parseTarget(d.master, "master") };
  if (d.previousMaster !== undefined) out.previousMaster = parseTarget(d.previousMaster, "previousMaster");
  if (d.candidate !== undefined) out.candidate = parseTarget(d.candidate, "candidate");
  if (d.lock !== undefined) {
    const l = d.lock as { since?: unknown; by?: unknown } | null;
    if (!l || typeof l.since !== "number" || typeof l.by !== "string") {
      throw new UserStoreError("calendar-settings.json lock is malformed");
    }
    out.lock = { since: l.since, by: l.by };
  }
  return out;
}

export function createCalendarSettingsStore(
  storage: CalendarSettingsStorage,
  now: () => number = Date.now,
): CalendarSettingsStore {
  void now; // reserved for API parity with createUserStore; no cache to age
  let queue: Promise<unknown> = Promise.resolve();
  return {
    read: () => storage.read(),
    // Serialized per instance: fresh read -> fn -> etag-guarded write. A write failure
    // (including a stale-etag precondition failure) propagates.
    mutate(fn) {
      const run = async (): Promise<CalendarSettings> => {
        const next = fn(await storage.read());
        await storage.write(next);
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
