import assert from "node:assert/strict";
import test from "node:test";
import {
  ALERTS_SEEN_KEY,
  DEFAULT_TAB,
  TAB_IDS,
  countUnseen,
  OWN_MOVES_KEY,
  addOwnMove,
  formatBadge,
  ownMoveKey,
  parseTab,
  readOwnMoves,
  readSeenAt,
  tabHref,
  writeSeenAt,
} from "../app/lib/nav.ts";

const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
  };
};
const blockedStorage = {
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("blocked"); },
};

test("lists the four destinations in bar order with ตาราง as the default", () => {
  assert.deepEqual([...TAB_IDS], ["schedule", "book", "search", "alerts"]);
  assert.equal(DEFAULT_TAB, "schedule");
});

test("parseTab accepts only the exact tab ids and otherwise falls back to schedule", () => {
  for (const id of TAB_IDS) assert.equal(parseTab(id), id);
  for (const bad of [null, undefined, "", "BOOK", "Book", " book", "zzz", "book,search", "__proto__"]) {
    assert.equal(parseTab(bad), "schedule", `value: ${String(bad)}`);
  }
});

test("tabHref builds a same-page query link", () => {
  assert.equal(tabHref("book"), "?tab=book");
  assert.equal(tabHref("schedule"), "?tab=schedule");
});

test("countUnseen counts only moves strictly newer than the last seen time", () => {
  const seen = Date.parse("2026-10-08T10:00:00Z");
  const moves = [
    { movedAt: "2026-10-08T10:00:01Z" },
    { movedAt: "2026-10-08T10:00:00Z" },
    { movedAt: "2026-10-07T10:00:00Z" },
    { movedAt: "not-a-date" },
    { movedAt: "" },
  ];
  assert.equal(countUnseen(moves, seen), 1);
  assert.equal(countUnseen([], seen), 0);
  assert.equal(countUnseen(moves, 0), 3);
});

test("formatBadge hides zero, shows 1-9 and caps at 9+", () => {
  assert.equal(formatBadge(0), "");
  assert.equal(formatBadge(-3), "");
  assert.equal(formatBadge(Number.NaN), "");
  assert.equal(formatBadge(1), "1");
  assert.equal(formatBadge(9), "9");
  assert.equal(formatBadge(10), "9+");
  assert.equal(formatBadge(250), "9+");
});

test("readSeenAt starts a new baseline at now on the first visit", () => {
  const storage = memoryStorage();
  assert.equal(readSeenAt(storage, 5000), 5000);
  assert.equal(storage.map.get(ALERTS_SEEN_KEY), "5000");
});

test("readSeenAt returns a stored value unchanged", () => {
  const storage = memoryStorage({ [ALERTS_SEEN_KEY]: "1234" });
  assert.equal(readSeenAt(storage, 9999), 1234);
  assert.equal(storage.map.get(ALERTS_SEEN_KEY), "1234");
});

test("readSeenAt treats corrupt stored values as a first visit", () => {
  for (const corrupt of ["abc", "", "0", "-5", "NaN", "Infinity"]) {
    const storage = memoryStorage({ [ALERTS_SEEN_KEY]: corrupt });
    assert.equal(readSeenAt(storage, 7000), 7000, `stored: ${JSON.stringify(corrupt)}`);
    assert.equal(storage.map.get(ALERTS_SEEN_KEY), "7000");
  }
});

test("storage failures never throw and fall back to now", () => {
  assert.equal(readSeenAt(blockedStorage, 4242), 4242);
  assert.equal(readSeenAt(null, 4242), 4242);
  assert.doesNotThrow(() => writeSeenAt(blockedStorage, 1));
  assert.doesNotThrow(() => writeSeenAt(null, 1));
});

test("writeSeenAt stores epoch milliseconds under the agreed key", () => {
  const storage = memoryStorage();
  writeSeenAt(storage, 8888);
  assert.equal(storage.map.get("or-queue:alerts-seen"), "8888");
});

test("countUnseen skips the user's own move but still counts another device's move from the same reload", () => {
  const seen = Date.parse("2026-10-08T10:00:00Z");
  const moves = [
    { id: "own", movedAt: "2026-10-08T10:05:00.000Z" },
    { id: "other", movedAt: "2026-10-08T10:04:00.000Z" },
  ];
  const own = new Set([ownMoveKey("own", "2026-10-08T10:05:00.000Z")]);
  assert.equal(countUnseen(moves, seen, own), 1);
  assert.equal(countUnseen(moves, seen), 2);
});

test("an older own-move key does not hide a later move of the same case", () => {
  const own = new Set([ownMoveKey("case-1", "2026-10-08T10:05:00.000Z")]);
  assert.equal(countUnseen([{ id: "case-1", movedAt: "2026-10-08T11:00:00.000Z" }], 0, own), 1);
});

test("addOwnMove persists keys, keeps only the newest 20, and survives blocked storage", () => {
  const storage = memoryStorage();
  let own = new Set();
  for (let i = 0; i < 25; i += 1) own = addOwnMove(storage, own, `m${i}`, `2026-10-08T10:${String(i).padStart(2, "0")}:00Z`);
  assert.equal(own.size, 20);
  assert.ok(own.has(ownMoveKey("m24", "2026-10-08T10:24:00Z")));
  assert.ok(!own.has(ownMoveKey("m0", "2026-10-08T10:00:00Z")));
  assert.deepEqual(readOwnMoves(storage), own);
  const blocked = addOwnMove(blockedStorage, new Set(), "x", "2026-10-08T10:00:00Z");
  assert.ok(blocked.has(ownMoveKey("x", "2026-10-08T10:00:00Z")));
});

test("readOwnMoves treats missing, corrupt or non-array storage as empty", () => {
  assert.equal(readOwnMoves(null).size, 0);
  assert.equal(readOwnMoves(blockedStorage).size, 0);
  for (const raw of ["not json", "{}", "42", "[1,2]"]) {
    const set = readOwnMoves(memoryStorage({ [OWN_MOVES_KEY]: raw }));
    assert.ok([...set].every((key) => typeof key === "string"), raw);
    assert.equal(set.size, 0, raw);
  }
});
