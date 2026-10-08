export const TAB_IDS = ["schedule", "book", "search", "alerts"] as const;
export type TabId = (typeof TAB_IDS)[number];
export const DEFAULT_TAB: TabId = "schedule";
export const ALERTS_SEEN_KEY = "or-queue:alerts-seen";

export type SeenStorage = Pick<Storage, "getItem" | "setItem">;

export function parseTab(value: string | null | undefined): TabId {
  return (TAB_IDS as readonly string[]).includes(value ?? "") ? (value as TabId) : DEFAULT_TAB;
}

export function tabHref(tab: TabId): string {
  return `?tab=${tab}`;
}

export const OWN_MOVES_KEY = "or-queue:own-moves";
const OWN_MOVES_LIMIT = 20;

export function ownMoveKey(id: string, movedAt: string): string {
  return `${id}|${movedAt}`;
}

export function countUnseen(
  moves: ReadonlyArray<{ id?: string; movedAt: string }>,
  lastSeenAt: number,
  ownMoves: ReadonlySet<string> = new Set(),
): number {
  let count = 0;
  for (const move of moves) {
    const movedAt = Date.parse(move.movedAt);
    if (!Number.isFinite(movedAt) || movedAt <= lastSeenAt) continue;
    if (move.id && ownMoves.has(ownMoveKey(move.id, move.movedAt))) continue;
    count += 1;
  }
  return count;
}

export function readOwnMoves(storage: SeenStorage | null): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(OWN_MOVES_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

export function addOwnMove(storage: SeenStorage | null, current: ReadonlySet<string>, id: string, movedAt: string): Set<string> {
  const next = new Set([...current, ownMoveKey(id, movedAt)]);
  const kept = new Set([...next].slice(-OWN_MOVES_LIMIT));
  try {
    storage?.setItem(OWN_MOVES_KEY, JSON.stringify([...kept]));
  } catch {
    // Ignore: worst case the user's own move shows once as unseen after a reload.
  }
  return kept;
}

export function formatBadge(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > 9 ? "9+" : String(count);
}

export function readSeenAt(storage: SeenStorage | null, now: number): number {
  try {
    const raw = storage?.getItem(ALERTS_SEEN_KEY);
    const stored = raw == null ? Number.NaN : Number(raw);
    if (Number.isFinite(stored) && stored > 0) return stored;
    storage?.setItem(ALERTS_SEEN_KEY, String(now));
  } catch {
    // Storage can be blocked (private mode); fall back to an in-memory baseline.
  }
  return now;
}

export function writeSeenAt(storage: SeenStorage | null, at: number): void {
  try {
    storage?.setItem(ALERTS_SEEN_KEY, String(at));
  } catch {
    // Ignore: the badge is a convenience, not a requirement.
  }
}

export function browserStorage(): SeenStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
