# Bottom Navigation Bar + UI/UX Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a four-tab bottom navigation bar (one screen at a time, ≤ 1000px only) with an unseen-moves badge, a compact top menu, a documented design system, and targeted mobile UI fixes to OR Queue, leaving desktop unchanged.

**Architecture:** Single page, single `SchedulerApp` client component. The active screen is the `?tab=` query value, switched with `window.history.replaceState` (no server round trip, no history pile-up). A `data-screen` attribute on `<main>` plus `data-screens` attributes on sections let CSS at ≤ 1000px hide inactive sections with `display: none`. A presentational `BottomNav` renders real `<a href="?tab=…">` links. Pure helpers (`parseTab`, `countUnseen`, badge/storage helpers) live in `app/lib/nav.ts` and are unit tested.

**Tech Stack:** Next.js 16.3 (App Router) · React 19.2 · TypeScript 5.9 · plain CSS (existing soft-UI tokens) · `node --test` · ESLint (react-hooks 7, jsx-a11y).

**Spec:** `docs/superpowers/specs/2026-10-08-bottom-nav-design.md` (read it first; this plan implements it, including its 2026-10-08 revision that replaces `next/link` with `history.replaceState`).

## Global Constraints

- Bottom bar, one-screen-at-a-time and the top "เมนู" button apply only at `@media (max-width: 1000px)`. Above 1000px nothing visible changes.
- Tab ids and order: `schedule` (default), `book`, `search`, `alerts`. Labels: ตาราง · ลงคิว · ค้นหา · แจ้งเตือน. Link form `?tab=<id>` (a relative query, so it resolves on `/` in production and on `/preview` while verifying).
- `<nav aria-label="เมนูหลัก">` of `<a>` links; active link has `aria-current="page"`; no emoji icons (inline SVG, `aria-hidden`).
- Bar label font ≥ 12px; each link ≥ 44px tall; bar `padding-bottom: env(safe-area-inset-bottom)`; `app/layout.tsx` exports `viewport = { viewportFit: "cover" }`.
- Label/icon colour contrast ≥ 4.5:1 against `--soft-base` (`#e0e5ec`).
- Tab switch: no animation, no history entry (`replaceState`), scroll to top.
- Badge: count of `recentMoves` with `movedAt` newer than `lastSeenAt`; `localStorage` key `or-queue:alerts-seen` (epoch ms); shows `1`–`9`, `9+`, nothing at 0; all storage access in try/catch; no backend change.
- Reuse existing tokens (`--rose`, `--ink`, `--muted`, `--soft-base`, `--raised`, `--pressed`, `--glass`); no new palette.
- Next.js here is v16.3: before writing Next-specific code, the relevant guide in `node_modules/next/dist/docs/` governs (already read: `useSearchParams`, `generateViewport`, native `history.replaceState` in the SPA guide).
- Node ≥ 22.13 per `package.json`; unit tests import `app/lib/nav.ts` directly, which needs Node's TypeScript type stripping (default on Node ≥ 22.18; local is Node 26). Keep `nav.ts` free of enums, namespaces and parameter properties.
- **Git:** the repo is on `main` with `AGENTS.md`, `CLAUDE.md` and `docs/` untracked. Do **not** commit, push or deploy unless the user has said so. Each task ends with a "Checkpoint" (status + tests), not a commit. If the user authorises commits, first run `git switch -c feat/bottom-nav`, then commit per task with the message shown in the checkpoint.

## Review Focus

Failure modes the spec implies but a happy-path test would miss, most likely first. Each has a pinned test in the owning task.

1. `?tab=` is missing, empty, repeated, wrong-cased or unknown (`?tab=BOOK`, `?tab=`, `?tab=zzz`) → must fall back to `schedule`, never blank the screen. (Task 3 `parseTab`, Task 5 browser check)
2. `localStorage` throws (Safari private mode / blocked) or is `null` → no crash, badge simply absent. (Task 3 `readSeenAt`/`writeSeenAt`)
3. Stored `lastSeenAt` is corrupt (`"abc"`, `""`, `"0"`, `"-5"`) → treated as first visit, not as "everything is unseen". (Task 3)
4. A move has an invalid `movedAt`, or `movedAt` equals `lastSeenAt` → must not be counted. (Task 3 `countUnseen`)
5. After a successful booking on a phone, switching to ตาราง must not steal focus from the sync-prompt dialog that opens at the same moment; and the user's own move must not appear as an unseen alert. (Task 5 browser check + source test)

---

### Task 1: Preview harness and baseline UI/UX review (spec §7, item 1)

**Files:**
- Create (temporary, never committed): `app/preview/page.tsx`, `app/preview/PreviewHarness.tsx`
- Create (scratch, outside repo): `$SCRATCH/pw/audit.mjs`
- Create: `docs/superpowers/specs/2026-10-08-ui-review-findings.md`

Set `SCRATCH=/private/tmp/claude-501/-Users-chagkrit/5396be8b-5af6-4942-a200-3fe4ae4c49af/scratchpad` for this and all later tasks.

**Interfaces:**
- Produces: route `/preview` (no login) that renders `SchedulerApp` with mocked `/api/*`; a `+ จำลองการสลับวัน` button (`#preview-add-move`) that prepends a move with `movedAt = now` to the mock list; a Playwright scratch project at `$SCRATCH/pw` used by Tasks 5–8; `docs/.../ui-review-findings.md` consumed by Task 7.

- [ ] **Step 1: Create the preview page**

`app/preview/page.tsx`:

```tsx
import PreviewHarness from "./PreviewHarness";

export default function PreviewPage() {
  return <PreviewHarness />;
}
```

- [ ] **Step 2: Create the harness with a mocked `fetch`**

`app/preview/PreviewHarness.tsx`:

```tsx
"use client";

import { Suspense } from "react";
import SchedulerApp from "../SchedulerApp";

type Move = {
  id: string;
  hn: string;
  patientName: string;
  operation: string;
  fromDate: string;
  toDate: string;
  movedAt: string;
  moveCount: number;
};

const DAY_MS = 86_400_000;

function bangkokIso(offsetDays: number) {
  return new Date(Date.now() + offsetDays * DAY_MS + 7 * 3_600_000).toISOString().slice(0, 10);
}

const moves: Move[] = [1, 2, 3].map((n) => ({
  id: `move-${n}`,
  hn: `1234500${n}`,
  patientName: `ผู้ป่วยทดสอบ ${n}`,
  operation: "Mastectomy",
  fromDate: bangkokIso(10 + n),
  toDate: bangkokIso(17 + n),
  movedAt: new Date(Date.now() - n * DAY_MS).toISOString(),
  moveCount: 1,
}));

function scheduleFixture() {
  const days: unknown[] = [];
  const bookings: unknown[] = [];
  for (let offset = 1; offset <= 45; offset += 1) {
    const date = bangkokIso(offset);
    const weekday = new Date(`${date}T12:00:00+07:00`).getUTCDay();
    if (weekday !== 2 && weekday !== 4) continue;
    const count = offset % 4;
    days.push({ date, queueType: "OR17", capacity: 4, note: "OR 17", count, cancerCount: count ? 1 : 0, closed: false, closureName: "", closureNote: "" });
    for (let slot = 1; slot <= count; slot += 1) {
      bookings.push({
        id: `booking-${date}-${slot}`,
        scheduleDate: date,
        queueType: "OR17",
        slotNo: slot,
        diagnosis: "CA breast",
        isCancer: true,
        neoadjuvantTreatment: false,
        hn: `9${slot}${String(offset).padStart(2, "0")}1234`,
        patientName: `ทดสอบ ระบบ${slot}`,
        operation: "Mastectomy",
        note: "",
        staffMembers: ["อ กีรติ"],
        calendarSyncStatus: "synced",
      });
    }
  }
  return {
    days,
    bookings,
    closures: [],
    horizonStart: bangkokIso(0),
    horizonEnd: bangkokIso(365),
    recentMoves: moves.slice(0, 10),
    importedCount: 0,
    calendarConnected: true,
    calendarName: "hnbcmu@gmail.com",
  };
}

type PreviewWindow = Window & { __previewFetchInstalled?: boolean };

if (typeof window !== "undefined" && !(window as PreviewWindow).__previewFetchInstalled) {
  (window as PreviewWindow).__previewFetchInstalled = true;
  const realFetch = window.fetch.bind(window);
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, window.location.origin);
    const method = (init?.method || "GET").toUpperCase();
    if (url.pathname === "/api/schedule" && method === "GET") return json(scheduleFixture());
    if (url.pathname === "/api/schedule") return json({ message: "บันทึกคิวแล้ว (preview)", booking: { date: bangkokIso(7), queueType: "OR17" } });
    if (url.pathname === "/api/presence") return json({ activeDevices: 2 });
    if (url.pathname === "/api/staff-schedule") return json({ cases: [] });
    if (url.pathname.startsWith("/api/")) return json({ error: "preview: endpoint นี้ไม่รองรับ" }, 501);
    return realFetch(input, init);
  };
}

export default function PreviewHarness() {
  return (
    <>
      <button
        id="preview-add-move"
        type="button"
        style={{ position: "fixed", top: 4, left: 4, zIndex: 200, fontSize: 12 }}
        onClick={() => {
          moves.unshift({
            id: `move-${Date.now()}`,
            hn: "12345999",
            patientName: "ผู้ป่วยใหม่ (จำลอง)",
            operation: "Mastectomy",
            fromDate: bangkokIso(12),
            toDate: bangkokIso(19),
            movedAt: new Date().toISOString(),
            moveCount: 1,
          });
        }}
      >
        + จำลองการสลับวัน
      </button>
      <Suspense fallback={null}>
        <SchedulerApp authorizedEmail="preview@example.com" />
      </Suspense>
    </>
  );
}
```

- [ ] **Step 3: Start the dev server and confirm the preview loads**

Run (background): `cd "<repo>" && npm run dev`
Then: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/preview`
Expected: `200`. If the port is busy, stop the other process or pass `-p 3100` and use that port everywhere below.

- [ ] **Step 4: Set up the scratch Playwright project**

```bash
SCRATCH=/private/tmp/claude-501/-Users-chagkrit/5396be8b-5af6-4942-a200-3fe4ae4c49af/scratchpad
mkdir -p "$SCRATCH/pw" && cd "$SCRATCH/pw" && npm init -y >/dev/null && npm i playwright-core
ls ~/Library/Caches/ms-playwright/chromium-*/ | head
```
Locate the Chromium executable (for example `~/Library/Caches/ms-playwright/chromium-1243/chrome-mac*/Chromium.app/Contents/MacOS/Chromium`) and export it: `export CHROMIUM_PATH="<that path>"`. If no executable exists, run `npx playwright-core install chromium` in `$SCRATCH/pw`.

- [ ] **Step 5: Write the audit script**

`$SCRATCH/pw/audit.mjs`:

```js
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3000/preview";
const SCRATCH = process.env.SCRATCH;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

async function audit(label, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForSelector(".day-card");
  await page.screenshot({ path: `${SCRATCH}/audit-${label}.png`, fullPage: true });
  const result = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const name = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""}`;
    const small = {};
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim()) continue;
      const el = node.parentElement;
      if (!el || !visible(el) || el.closest("#preview-add-move")) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) {
        const key = `${size}px ${name(el)}`;
        small[key] = (small[key] || 0) + 1;
      }
    }
    const targets = {};
    document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role="tab"]').forEach((el) => {
      if (!visible(el) || el.closest("#preview-add-move")) return;
      const r = el.getBoundingClientRect();
      if (r.height < 44 || r.width < 44) {
        const key = `${Math.round(r.width)}x${Math.round(r.height)} ${name(el)}`;
        targets[key] = (targets[key] || 0) + 1;
      }
    });
    return {
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      pageHeight: document.documentElement.scrollHeight,
      smallText: Object.entries(small).sort((a, b) => b[1] - a[1]),
      smallTargets: Object.entries(targets).sort((a, b) => b[1] - a[1]),
    };
  });
  await context.close();
  return result;
}

const out = {
  phone390: await audit("phone390", { width: 390, height: 844 }),
  desktop1280: await audit("desktop1280", { width: 1280, height: 800 }),
};
console.log(JSON.stringify(out, null, 2));
await browser.close();
```

- [ ] **Step 6: Run the audit**

Run: `cd "$SCRATCH/pw" && SCRATCH="$SCRATCH" node audit.mjs > audit.json && node -e "const r=require('./audit.json'); for (const k of Object.keys(r)) console.log(k, 'overflow', r[k].horizontalOverflow, 'smallText', r[k].smallText.length, 'smallTargets', r[k].smallTargets.length)"`
Expected: both keys print; `phone390` shows many `smallText` and `smallTargets` entries (this is the baseline). Open `$SCRATCH/audit-phone390.png` with the Read tool and look at it.

- [ ] **Step 7: Write the findings document**

Create `docs/superpowers/specs/2026-10-08-ui-review-findings.md` with: (a) a short method note (preview route, 390×844 and 1280×800, audit script, date), (b) a table `Severity | Area | Finding | Evidence | Planned in task` built from `audit.json` and the screenshot, with severity High for interaction targets and text < 12px on primary flows (booking form, tabs, case search), Medium for secondary text, Low for cosmetic; every row must cite a real entry from `audit.json` (for example `8px button.schedule-tabs…`) or a visible defect in the screenshot, and name Task 5 (bottom bar), Task 6 (top menu), Task 7 (polish) or "not planned". Do not list anything the audit did not show.

- [ ] **Step 8: Checkpoint**

Run: `npm run lint` and `npm test`
Expected: lint passes with no new errors in `app/preview/*` (fix any), 22 existing tests pass.
`git status --short` shows `app/preview/` and `docs/` as untracked; this is expected. (If commits are authorised: do not add `app/preview/`.)

---

### Task 2: Design-system document (spec §8, item 3)

**Files:**
- Create: `design-system/operative-schedule/MASTER.md`

**Interfaces:**
- Consumes: token values from `app/globals.css` (`:root` blocks at lines 3–14 and 526–546).
- Produces: `MASTER.md` documenting existing tokens and the bar tokens defined in Task 4 (`--bottom-nav-height: 64px`, `--bottom-nav-muted: #4b5a6b`, `--bottom-nav-active: #a71955`).

- [ ] **Step 1: Re-read the token blocks**

Run: `sed -n 1,14p app/globals.css && sed -n 526,546p app/globals.css`
Copy the values exactly in the next step; if any value differs from what is written below, the file wins.

- [ ] **Step 2: Write the document**

`design-system/operative-schedule/MASTER.md`:

```markdown
# Operative Schedule (OR Queue) — Design System (MASTER)

Status: documents the interface as it is on 2026-10-08. It does not introduce a new palette. Page overrides, if ever needed, go in `pages/<name>.md` and win over this file.

## Principles
- Soft-UI ("neumorphic") matte surfaces; only controls float as glass.
- Borders are never the affordance (`border: 0 !important` globally); depth comes from `--raised` / `--pressed` shadows.
- Thai-first copy; Gregorian ISO dates stored, Buddhist-era dates displayed.
- One accent: rose. Status colours: green (synced), amber (pending), `--danger` for destructive.

## Colour tokens (final cascade values, from the "Soft UI + Liquid Glass" `:root` block)
| Token | Value | Use |
|---|---|---|
| `--soft-base` / `--cream` | `#e0e5ec` | page and surface background |
| `--ink` | `#243140` | primary text |
| `--muted` | `#596879` | secondary text (4.50:1 on `--soft-base`; do not use for text smaller than 12px) |
| `--rose` | `#a71955` | primary accent, selected state (5.7:1 on `--soft-base`) |
| `--rose-deep` | `#78113d` | hover/pressed accent, headings accent |
| `--rose-soft` | `#e8dce5` | tinted fills |
| `--green` | `#197a60` | synced / connected |
| `--danger` | `#a71955` | destructive confirmation |
| `--glass` | `rgba(230, 237, 246, .60)` | floating controls |

## Elevation
- `--raised`: `-6px -6px 12px var(--soft-light), 6px 6px 12px var(--soft-shadow)`
- `--raised-large`: `-10px -10px 24px …, 10px 10px 24px …`
- `--pressed`: inset equivalent, used for selected / active controls
- `--glass-highlight`: glass control edge + shadow

## Typography
- Body: `"Noto Sans Thai", "Leelawadee UI", Tahoma, Arial, sans-serif`
- Display (h1/h2/h3): Georgia / serif stack, `letter-spacing` slightly negative
- **Floor on phones (≤ 650px): 12px for text, 16px for text inputs** (prevents iOS focus-zoom). Exception: 7-column calendar cell micro-labels may be 10px because cells are ~44px wide.

## Spacing, shape, targets
- Panel radius 26–28px; control radius 999px (pills) or 12–14px.
- Touch targets ≥ 44px tall on phones.
- App shell max width 1540px; side padding 42 / 22 / 14px at > 1000 / ≤ 1000 / ≤ 650px.

## Breakpoints
| Max width | Behaviour |
|---|---|
| 1000px | single column; **bottom navigation bar + one screen at a time**; top bar collapses to "เมนู" |
| 820px | top bar actions wrap (legacy rules) |
| 650px | phone density; text/target floors above |
| 480px | smallest phones |

## Bottom navigation bar (added 2026-10-08)
| Token / rule | Value |
|---|---|
| `--bottom-nav-height` | `64px` (+ `env(safe-area-inset-bottom)`) |
| `--bottom-nav-muted` | `#4b5a6b` (5.6:1 on `--soft-base`) |
| `--bottom-nav-active` | `#a71955` (5.7:1) |
| Icon | 24px inline SVG, stroke 1.9, `aria-hidden` |
| Label | 12px / 700; active 900 |
| Active indicator | icon pill with `--pressed` shadow **and** colour (never colour alone) |
| Badge | min 18px, `--rose` fill, white 12px/800 numeral, `9+` cap |
| z-index order | notice 10 < bottom bar 50 < top menu 60 < dialogs 100 |
| Tabs | ตาราง `schedule` · ลงคิว `book` · ค้นหา `search` · แจ้งเตือน `alerts` |

## Accessibility rules
- Focus ring: `3px solid #5635d4`, offset 4px (inside the bar: offset −4px).
- `prefers-reduced-motion` removes all transitions; tab switching never animates.
- Hidden screens use `display: none` (not focusable, not read).
```

- [ ] **Step 3: Verify the document matches the CSS**

Run: `grep -c "#e0e5ec\|#243140\|#596879\|#a71955\|#78113d\|#197a60" design-system/operative-schedule/MASTER.md app/globals.css`
Expected: both files report matches; spot-check `--muted: #596879` appears in both.

- [ ] **Step 4: Checkpoint**

Run: `npm test`
Expected: PASS (no code changed). If commits are authorised: `git add design-system docs && git commit -m "docs: add UI review findings and design system"`.

---

### Task 3: Navigation helpers with unit tests

**Files:**
- Create: `app/lib/nav.ts`
- Create: `tests/nav.test.mjs`

**Interfaces:**
- Produces (exact signatures, used by Tasks 4–6):

```ts
export const TAB_IDS: readonly ["schedule", "book", "search", "alerts"];
export type TabId = "schedule" | "book" | "search" | "alerts";
export const DEFAULT_TAB: TabId;                       // "schedule"
export const ALERTS_SEEN_KEY: string;                  // "or-queue:alerts-seen"
export type SeenStorage = Pick<Storage, "getItem" | "setItem">;
export function parseTab(value: string | null | undefined): TabId;
export function tabHref(tab: TabId): string;           // `?tab=${tab}`
export function countUnseen(moves: ReadonlyArray<{ movedAt: string }>, lastSeenAt: number): number;
export function formatBadge(count: number): string;    // "" | "1".."9" | "9+"
export function readSeenAt(storage: SeenStorage | null, now: number): number;
export function writeSeenAt(storage: SeenStorage | null, at: number): void;
export function browserStorage(): SeenStorage | null;
```

- [ ] **Step 1: Write the failing tests**

`tests/nav.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  ALERTS_SEEN_KEY,
  DEFAULT_TAB,
  TAB_IDS,
  countUnseen,
  formatBadge,
  parseTab,
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/nav.test.mjs`
Expected: FAIL (`Cannot find module '../app/lib/nav.ts'`).

- [ ] **Step 3: Implement the helpers**

`app/lib/nav.ts`:

```ts
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

export function countUnseen(moves: ReadonlyArray<{ movedAt: string }>, lastSeenAt: number): number {
  let count = 0;
  for (const move of moves) {
    const movedAt = Date.parse(move.movedAt);
    if (Number.isFinite(movedAt) && movedAt > lastSeenAt) count += 1;
  }
  return count;
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/nav.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 5: Checkpoint**

Run: `npm run lint && npm test`
Expected: lint clean; 22 existing + 10 new tests pass. If commits are authorised: `git add app/lib/nav.ts tests/nav.test.mjs && git commit -m "feat: add bottom-nav tab and unseen-badge helpers"`.

---

### Task 4: BottomNav component, bar styles and viewport

**Files:**
- Create: `app/BottomNav.tsx`
- Create: `app/mobile-shell.css`
- Modify: `app/layout.tsx` (viewport export + CSS import)
- Test: `tests/mobile-shell.test.mjs`

**Interfaces:**
- Consumes: `TAB_IDS`, `TabId`, `formatBadge`, `tabHref` from `app/lib/nav.ts`.
- Produces: default export `BottomNav(props: { active: TabId; unseenAlerts: number; onSelect: (tab: TabId) => void })`; CSS classes `.bottom-nav`, `.bottom-nav-link`, `.bottom-nav-icon`, `.bottom-nav-label`, `.bottom-nav-badge`; tokens `--bottom-nav-height`, `--bottom-nav-muted`, `--bottom-nav-active`. Later tasks append to `app/mobile-shell.css`.

- [ ] **Step 1: Write the failing source tests**

`tests/mobile-shell.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const channel = (value) => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const token = (css, name) => css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];

test("bottom bar is a labelled nav of links with aria-current and no push animation", async () => {
  const nav = await read("app/BottomNav.tsx");
  assert.match(nav, /<nav className="bottom-nav" aria-label="เมนูหลัก">/);
  assert.match(nav, /aria-current=\{isActive \? "page" : undefined\}/);
  assert.match(nav, /href=\{tabHref\(tab\)\}/);
  assert.match(nav, /aria-hidden="true"/);
  assert.doesNotMatch(nav, /next\/link/);
  for (const label of ["ตาราง", "ลงคิว", "ค้นหา", "แจ้งเตือน"]) assert.match(nav, new RegExp(label));
});

test("bar clears the iPhone home indicator and is phone-only", async () => {
  const css = await read("app/mobile-shell.css");
  const layout = await read("app/layout.tsx");
  assert.match(css, /padding-bottom: env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.bottom-nav[^{]*\{[^}]*display: none/);
  assert.match(css, /@media \(max-width: 1000px\)/);
  assert.match(layout, /viewportFit: "cover"/);
  assert.match(layout, /import "\.\/mobile-shell\.css"/);
});

test("bar labels are at least 12px, links at least 44px tall, and there is no transition", async () => {
  const css = await read("app/mobile-shell.css");
  const bar = css.slice(css.indexOf("@media (max-width: 1000px)"));
  assert.match(bar, /\.bottom-nav-link\s*\{[^}]*font-size: 12px/);
  assert.match(css, /--bottom-nav-height: 64px/);
  assert.match(bar, /min-height: var\(--bottom-nav-height\)/);
  assert.doesNotMatch(css.slice(css.indexOf(".bottom-nav-link")), /transition:/);
});

test("bar text and icon colours keep 4.5:1 contrast on the soft surface", async () => {
  const css = await read("app/mobile-shell.css");
  const globals = await read("app/globals.css");
  const surface = token(globals, "--soft-base");
  assert.equal(surface, "#e0e5ec");
  for (const name of ["--bottom-nav-muted", "--bottom-nav-active"]) {
    const colour = token(css, name);
    assert.ok(colour, `${name} defined`);
    assert.ok(contrast(colour, surface) >= 4.5, `${name} ${colour} contrast ${contrast(colour, surface).toFixed(2)}`);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/mobile-shell.test.mjs`
Expected: FAIL (files missing).

- [ ] **Step 3: Create the component**

`app/BottomNav.tsx`:

```tsx
"use client";

import type { MouseEvent, ReactNode } from "react";
import { TAB_IDS, formatBadge, tabHref, type TabId } from "./lib/nav";

const TABS: Record<TabId, { label: string; icon: ReactNode }> = {
  schedule: {
    label: "ตาราง",
    icon: (
      <>
        <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
        <path d="M8 3v4M16 3v4M3.5 10h17" />
      </>
    ),
  },
  book: {
    label: "ลงคิว",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v8M8 12h8" />
      </>
    ),
  },
  search: {
    label: "ค้นหา",
    icon: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
  },
  alerts: {
    label: "แจ้งเตือน",
    icon: (
      <>
        <path d="M6 17v-6a6 6 0 0 1 12 0v6l1.5 2h-15z" />
        <path d="M10 21a2 2 0 0 0 4 0" />
      </>
    ),
  },
};

type BottomNavProps = {
  active: TabId;
  unseenAlerts: number;
  onSelect: (tab: TabId) => void;
};

export default function BottomNav({ active, unseenAlerts, onSelect }: BottomNavProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>, tab: TabId) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onSelect(tab);
  }

  return (
    <nav className="bottom-nav" aria-label="เมนูหลัก">
      {TAB_IDS.map((tab) => {
        const { label, icon } = TABS[tab];
        const isActive = tab === active;
        const badge = tab === "alerts" ? formatBadge(unseenAlerts) : "";
        return (
          <a
            key={tab}
            href={tabHref(tab)}
            className="bottom-nav-link"
            aria-current={isActive ? "page" : undefined}
            aria-label={badge ? `${label} ยังไม่ได้ดู ${unseenAlerts} รายการ` : undefined}
            onClick={(event) => handleClick(event, tab)}
          >
            <span className="bottom-nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">{icon}</svg>
              {badge && <span className="bottom-nav-badge">{badge}</span>}
            </span>
            <span className="bottom-nav-label">{label}</span>
          </a>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 4: Create the bar stylesheet**

`app/mobile-shell.css`:

```css
/* Mobile shell (≤ 1000px): bottom navigation bar, one-screen-at-a-time, top menu, phone polish.
   Imported after globals.css and staff-selector-v2.css so equal-specificity rules here win. */

:root {
  --bottom-nav-height: 64px;
  --bottom-nav-muted: #4b5a6b;
  --bottom-nav-active: #a71955;
}

.bottom-nav { display: none; }

@media (max-width: 1000px) {
  .app-shell { padding-bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 22px); }

  .bottom-nav {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--soft-base);
    box-shadow: 0 -8px 20px rgba(135, 151, 173, .38);
  }

  .bottom-nav-link {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    min-height: var(--bottom-nav-height);
    padding: 6px 4px;
    color: var(--bottom-nav-muted);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.2;
    text-decoration: none;
    -webkit-tap-highlight-color: transparent;
  }
  .bottom-nav-link[aria-current="page"] { color: var(--bottom-nav-active); font-weight: 900; }
  .bottom-nav-link:focus-visible { outline: 3px solid #5635d4; outline-offset: -4px; border-radius: 16px; }

  .bottom-nav-icon {
    position: relative;
    display: inline-flex;
    padding: 4px 18px;
    border-radius: 999px;
  }
  .bottom-nav-link[aria-current="page"] .bottom-nav-icon { box-shadow: var(--pressed); }
  .bottom-nav-icon svg {
    width: 24px;
    height: 24px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .bottom-nav-badge {
    position: absolute;
    top: -4px;
    left: calc(50% + 4px);
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    color: #fff;
    background: var(--rose);
    font: 800 12px/18px "Noto Sans Thai", Tahoma, Arial, sans-serif;
    text-align: center;
  }
}
```

- [ ] **Step 5: Update the layout**

In `app/layout.tsx` change the import line `import type { Metadata } from "next";` to `import type { Metadata, Viewport } from "next";`, add `import "./mobile-shell.css";` after the `./staff-selector-v2.css` import, and add above `generateMetadata`:

```tsx
export const viewport: Viewport = { viewportFit: "cover" };
```

- [ ] **Step 6: Run the tests**

Run: `node --test tests/mobile-shell.test.mjs`
Expected: PASS, 4 tests (contrast test prints actual ratios on failure).

- [ ] **Step 7: Checkpoint**

Run: `npm run lint && npm test`
Expected: clean; all tests pass (the existing layout test still matches `import "./staff-selector-v2.css"`). The bar is not yet rendered anywhere. If commits are authorised: `git add app/BottomNav.tsx app/mobile-shell.css app/layout.tsx tests/mobile-shell.test.mjs && git commit -m "feat: add bottom navigation bar component and styles"`.

---

### Task 5: Wire tabs, screens, badge and booking switch into SchedulerApp

**Files:**
- Create: `app/useUnseenMoves.ts`
- Modify: `app/SchedulerApp.tsx` (imports ~line 3–7; state after line 479; `<main>` line 1083; section tags at 1103, 1248, 1249, 1377, 1447, 1448, 1488; end of `<main>` before line 1504; `submitBooking` after `await loadSchedule()` at ~880; `moveCase` after `await loadSchedule()` at ~1022)
- Modify: `app/page.tsx` (Suspense)
- Modify: `app/mobile-shell.css` (append visibility rules)
- Test: `tests/mobile-shell.test.mjs` (append), `$SCRATCH/pw/verify.mjs`

**Interfaces:**
- Consumes: `parseTab`, `tabHref`, `TabId`, `countUnseen`, `readSeenAt`, `writeSeenAt`, `browserStorage` (Task 3); `BottomNav` (Task 4).
- Produces: `useUnseenMoves(moves: { movedAt: string }[] | undefined, alertsActive: boolean): { unseen: number; markSeen: () => void }`; in `SchedulerApp`: `activeTab: TabId`, `selectTab(tab: TabId, options?: { focus?: boolean }): void`, `menuOpen`-free (menu is Task 6); DOM contract used by CSS and `verify.mjs`: `<main data-screen={activeTab}>`, sections carry `data-screens="…"`, panels carry `id="screen-<tab>"` and `tabIndex={-1}`.

- [ ] **Step 1: Append failing source tests**

Append to `tests/mobile-shell.test.mjs`:

```js
test("SchedulerApp maps every screen to a tab and switches with replaceState", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const page = await read("app/page.tsx");
  assert.match(app, /parseTab\(searchParams\.get\("tab"\)\)/);
  assert.match(app, /window\.history\.replaceState\(null, "", tabHref\(tab\)\)/);
  assert.match(app, /<main className="app-shell" data-screen=\{activeTab\}>/);
  assert.match(app, /className="hero" data-screens="schedule"/);
  assert.match(app, /className="workspace-grid" data-screens="book schedule"/);
  assert.match(app, /className="panel booking-panel" id="screen-book" tabIndex=\{-1\} data-screens="book"/);
  assert.match(app, /className="panel schedule-panel" id="screen-schedule" tabIndex=\{-1\} data-screens="schedule"/);
  assert.match(app, /className="case-tools-grid" data-screens="search alerts"/);
  assert.match(app, /className="panel case-search-panel" id="screen-search" tabIndex=\{-1\} data-screens="search"/);
  assert.match(app, /className="panel move-history-panel" id="screen-alerts" tabIndex=\{-1\} data-screens="alerts"/);
  assert.match(app, /<BottomNav active=\{activeTab\} unseenAlerts=\{unseen\} onSelect=\{selectTab\} \/>/);
  assert.match(page, /<Suspense/);
});

test("a successful phone booking returns to ตาราง without stealing focus, and own moves are marked seen", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /matchMedia\("\(max-width: 1000px\)"\)\.matches\) selectTab\("schedule", \{ focus: false \}\)/);
  const moveCase = app.slice(app.indexOf("async function moveCase"), app.indexOf("const deleteHnMatches"));
  assert.match(moveCase, /markSeen\(\)/);
});

test("inactive screens are removed from layout (and the focus order) only on phones and tablets", async () => {
  const css = await read("app/mobile-shell.css");
  for (const tab of ["schedule", "book", "search", "alerts"]) {
    assert.match(css, new RegExp(`\\.app-shell\\[data-screen="${tab}"\\] \\[data-screens\\]:not\\(\\[data-screens~="${tab}"\\]\\)`));
  }
  const phone = css.slice(css.indexOf("@media (max-width: 1000px)"));
  assert.match(phone, /\[data-screens\][^{]*\{[^}]*display: none/);
  assert.doesNotMatch(css.slice(0, css.indexOf("@media (max-width: 1000px)")), /data-screens/);
});
```

Run: `node --test tests/mobile-shell.test.mjs`
Expected: the 3 new tests FAIL.

- [ ] **Step 2: Create the badge hook**

`app/useUnseenMoves.ts`:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import { browserStorage, countUnseen, readSeenAt, writeSeenAt } from "./lib/nav";

export function useUnseenMoves(moves: ReadonlyArray<{ movedAt: string }> | undefined, alertsActive: boolean) {
  const [seenAt, setSeenAt] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setSeenAt(readSeenAt(browserStorage(), Date.now())), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const markSeen = useCallback(() => {
    const now = Date.now();
    writeSeenAt(browserStorage(), now);
    setSeenAt(now);
  }, []);

  useEffect(() => {
    if (!alertsActive || !moves) return;
    const timer = window.setTimeout(markSeen, 0);
    return () => window.clearTimeout(timer);
  }, [alertsActive, moves, markSeen]);

  return { unseen: seenAt === null || !moves ? 0 : countUnseen(moves, seenAt), markSeen };
}
```

- [ ] **Step 3: Update `app/page.tsx`**

Replace the file's content with:

```tsx
import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth, AUTHORIZED_EMAIL } from "../auth";
import SchedulerApp from "./SchedulerApp";

export const metadata: Metadata = {
  title: "OR Queue | Breast & Endocrine Surgery CMU",
  description: "ระบบลงคิวผ่าตัด OR 17 และ OR Extra",
};

export default async function Home() {
  const session = await auth();
  if (session?.user?.email?.toLowerCase() !== AUTHORIZED_EMAIL) redirect("/signin");
  return (
    <Suspense fallback={null}>
      <SchedulerApp authorizedEmail={AUTHORIZED_EMAIL} />
    </Suspense>
  );
}
```

- [ ] **Step 4: Edit `SchedulerApp.tsx` imports**

Replace line 4 `import Image from "next/image";` with:

```tsx
import Image from "next/image";
import { useSearchParams } from "next/navigation";
```
and after `import { diagnosisIsCancer } from "./lib/schedule";` add:

```tsx
import BottomNav from "./BottomNav";
import { parseTab, tabHref, type TabId } from "./lib/nav";
import { useUnseenMoves } from "./useUnseenMoves";
```

- [ ] **Step 5: Add tab state, `selectTab` and the badge hook**

Directly after the line `  const [exporting, setExporting] = useState(false);` insert:

```tsx
  const searchParams = useSearchParams();
  const activeTab = parseTab(searchParams.get("tab"));
  const focusScreenRef = useRef(false);
  const { unseen, markSeen } = useUnseenMoves(data?.recentMoves, activeTab === "alerts");

  const selectTab = useCallback((tab: TabId, options: { focus?: boolean } = {}) => {
    window.scrollTo({ top: 0, left: 0 });
    if (parseTab(new URLSearchParams(window.location.search).get("tab")) === tab) return;
    focusScreenRef.current = options.focus !== false;
    window.history.replaceState(null, "", tabHref(tab));
  }, []);

  useEffect(() => {
    if (!focusScreenRef.current) return;
    focusScreenRef.current = false;
    document.getElementById(`screen-${activeTab}`)?.focus({ preventScroll: true });
  }, [activeTab]);
```

- [ ] **Step 6: Mark the screens**

Apply these exact string replacements in `SchedulerApp.tsx`:

| Find | Replace with |
|---|---|
| `<main className="app-shell">` | `<main className="app-shell" data-screen={activeTab}>` |
| `<section className="hero">` | `<section className="hero" data-screens="schedule">` |
| `<div className="workspace-grid">` | `<div className="workspace-grid" data-screens="book schedule">` |
| `<section className="panel booking-panel">` | `<section className="panel booking-panel" id="screen-book" tabIndex={-1} data-screens="book">` |
| `<aside className="panel schedule-panel">` | `<aside className="panel schedule-panel" id="screen-schedule" tabIndex={-1} data-screens="schedule">` |
| `<section className="case-tools-grid" aria-label="ค้นหาและประวัติการสลับวันผ่าตัด">` | `<section className="case-tools-grid" data-screens="search alerts" aria-label="ค้นหาและประวัติการสลับวันผ่าตัด">` |
| `<div className="panel case-search-panel">` | `<div className="panel case-search-panel" id="screen-search" tabIndex={-1} data-screens="search">` |
| `<aside className="panel move-history-panel">` | `<aside className="panel move-history-panel" id="screen-alerts" tabIndex={-1} data-screens="alerts">` |

(The spec test in Step 1 matches `className="…" id=… tabIndex={-1} data-screens=…` in exactly this attribute order; for the `case-tools-grid` section the test expects `className=… data-screens=…` adjacent, which the table satisfies.)

- [ ] **Step 7: Render the bar**

Immediately before the closing `    </main>` at the end of the component's JSX, after the `</footer>` line, insert:

```tsx
      <BottomNav active={activeTab} unseenAlerts={unseen} onSelect={selectTab} />
```

- [ ] **Step 8: Switch to ตาราง after a phone booking; mark own moves seen**

In `submitBooking`, replace the line `      await loadSchedule();` that follows `setForm(EMPTY_FORM);` with:

```tsx
      await loadSchedule();
      if (window.matchMedia("(max-width: 1000px)").matches) selectTab("schedule", { focus: false });
```
In `moveCase`, replace the two lines
```tsx
      await loadSchedule();
      await searchCases();
```
with
```tsx
      await loadSchedule();
      markSeen();
      await searchCases();
```

- [ ] **Step 9: Append the visibility rules**

Append to `app/mobile-shell.css` (inside a new phone-only block):

```css
@media (max-width: 1000px) {
  .app-shell[data-screen="schedule"] [data-screens]:not([data-screens~="schedule"]),
  .app-shell[data-screen="book"] [data-screens]:not([data-screens~="book"]),
  .app-shell[data-screen="search"] [data-screens]:not([data-screens~="search"]),
  .app-shell[data-screen="alerts"] [data-screens]:not([data-screens~="alerts"]) {
    display: none;
  }
}
```
(Keep this as a separate `@media (max-width: 1000px)` block after the bar block; the test slices from the first such block.)

- [ ] **Step 10: Run unit/source tests, lint, build**

Run: `node --test tests/mobile-shell.test.mjs && npm run lint && npm run build`
Expected: all PASS; build succeeds. If `build` reports `useSearchParams() should be wrapped in a suspense boundary`, re-check Step 3; do not silence it.

- [ ] **Step 11: Write the browser verification script**

`$SCRATCH/pw/verify.mjs`:

```js
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3000/preview";
const SCRATCH = process.env.SCRATCH;
const groups = new Set((process.argv[2] || "nav,desktop").split(","));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

async function open(viewport, url = BASE) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: viewport.width < 800, hasTouch: viewport.width < 800 });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector(".day-card");
  return { context, page };
}
const shown = (page, selector) => page.locator(selector).first().isVisible();

if (groups.has("nav")) {
  const { context, page } = await open({ width: 390, height: 844 });
  const navLinks = page.locator(".bottom-nav a");
  check("bar has four links", (await navLinks.count()) === 4);
  check("ตาราง is current by default", (await page.locator('.bottom-nav a[aria-current="page"]').innerText()).includes("ตาราง"));
  check("schedule visible, booking hidden, hero visible", (await shown(page, ".schedule-panel")) && !(await shown(page, ".booking-panel")) && (await shown(page, ".hero")));
  check("hidden panel controls are not focusable/visible", !(await shown(page, ".booking-panel input")));

  const historyBefore = await page.evaluate(() => history.length);
  await page.click('.bottom-nav a[href="?tab=book"]');
  await page.waitForSelector(".booking-panel", { state: "visible" });
  check("book tab shows booking, hides schedule and hero", (await shown(page, ".booking-panel")) && !(await shown(page, ".schedule-panel")) && !(await shown(page, ".hero")));
  check("URL is ?tab=book", new URL(page.url()).searchParams.get("tab") === "book");
  check("tab switch added no history entry", (await page.evaluate(() => history.length)) === historyBefore);
  check("screen received focus after switch", await page.evaluate(() => document.activeElement?.id === "screen-book"));
  check("aria-current moved to ลงคิว", (await page.locator('.bottom-nav a[aria-current="page"]').innerText()).includes("ลงคิว"));

  await page.click('.bottom-nav a[href="?tab=search"]');
  check("search tab shows search, hides history", (await shown(page, ".case-search-panel")) && !(await shown(page, ".move-history-panel")));
  await page.click('.bottom-nav a[href="?tab=alerts"]');
  check("alerts tab shows history, hides search", (await shown(page, ".move-history-panel")) && !(await shown(page, ".case-search-panel")));

  const box = await page.locator(".bottom-nav").boundingBox();
  check("bar is pinned to the bottom edge", Math.abs(box.y + box.height - 844) <= 1, JSON.stringify(box));
  const metrics = await page.evaluate(() => {
    const link = document.querySelector(".bottom-nav-link");
    const label = document.querySelector(".bottom-nav-label");
    const rules = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } });
    const text = (rule) => rule.cssText || "";
    return {
      linkHeight: link.getBoundingClientRect().height,
      labelSize: parseFloat(getComputedStyle(label).fontSize),
      safeArea: rules.some((r) => text(r).includes("env(safe-area-inset-bottom)")),
      viewport: document.querySelector('meta[name="viewport"]')?.content || "",
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  check("link ≥ 44px tall", metrics.linkHeight >= 44, String(metrics.linkHeight));
  check("label ≥ 12px", metrics.labelSize >= 12, String(metrics.labelSize));
  check("safe-area padding rule present", metrics.safeArea);
  check("viewport-fit=cover present", metrics.viewport.includes("viewport-fit=cover"), metrics.viewport);
  check("no horizontal overflow on alerts", !metrics.overflow);

  // deep links and bad values
  for (const [query, expected] of [["?tab=search", "ค้นหา"], ["?tab=BOOK", "ตาราง"], ["?tab=", "ตาราง"], ["?tab=zzz", "ตาราง"], ["?tab=book&tab=search", "ลงคิว"]]) {
    await page.goto(BASE + query);
    await page.waitForSelector(".bottom-nav");
    const current = await page.locator('.bottom-nav a[aria-current="page"]').innerText();
    check(`deep link ${query || "(empty)"} → ${expected}`, current.includes(expected), current);
  }

  // badge: add a move, Sync, see badge, open alerts, badge clears
  await page.goto(BASE);
  await page.waitForSelector(".bottom-nav");
  await page.waitForTimeout(300);
  check("badge starts hidden on first visit", (await page.locator(".bottom-nav-badge").count()) === 0);
  await page.click("#preview-add-move");
  const menuToggle = page.locator(".menu-button");
  if (await menuToggle.isVisible()) await menuToggle.click();
  await page.click(".sync-button");
  await page.waitForSelector(".bottom-nav-badge");
  check("badge shows 1 after a new move", (await page.locator(".bottom-nav-badge").innerText()) === "1");
  check("link aria-label announces the count", ((await page.locator('.bottom-nav a[href="?tab=alerts"]').getAttribute("aria-label")) || "").includes("ยังไม่ได้ดู 1 รายการ"));
  await page.click('.bottom-nav a[href="?tab=alerts"]');
  await page.waitForFunction(() => !document.querySelector(".bottom-nav-badge"));
  check("badge clears after opening alerts", true);
  await page.screenshot({ path: `${SCRATCH}/nav-alerts-390.png` });

  // booking success returns to ตาราง and leaves focus in the sync dialog
  await page.click('.bottom-nav a[href="?tab=book"]');
  await page.fill('input[placeholder*="DCIS"]', "CA breast");
  await page.fill('input[placeholder="Hospital number"]', "123456");
  await page.fill('input[placeholder="เบอร์โทรศัพท์"]', "0812345678");
  await page.fill('input[placeholder="ชื่อผู้ป่วย"]', "ทดสอบ");
  await page.fill('input[placeholder="นามสกุล"]', "ระบบ");
  await page.fill('input[placeholder="ชื่อหัตถการ / การผ่าตัด"]', "Mastectomy");
  await page.locator(".staff-selector input[type=checkbox]").first().check();
  await page.click('.booking-panel button[type="submit"]');
  await page.waitForSelector(".sync-confirm-dialog");
  await page.waitForFunction(() => new URLSearchParams(location.search).get("tab") === "schedule");
  check("booking success switched to ตาราง", new URL(page.url()).searchParams.get("tab") === "schedule");
  check("focus stayed inside the sync dialog", await page.evaluate(() => !!document.activeElement?.closest(".sync-confirm-dialog")));
  check("dialog is above the bar", await page.evaluate(() => {
    const dialog = document.querySelector(".queue-conflict-backdrop");
    return Number(getComputedStyle(dialog).zIndex) > Number(getComputedStyle(document.querySelector(".bottom-nav")).zIndex);
  }));
  await page.screenshot({ path: `${SCRATCH}/nav-booking-success-390.png` });
  await context.close();
}

if (groups.has("menu")) {
  const { context, page } = await open({ width: 390, height: 844 });
  const button = page.locator(".menu-button");
  check("menu button visible on phones", await button.isVisible());
  check("menu closed: sync hidden", !(await shown(page, ".sync-button")));
  check("aria-expanded=false", (await button.getAttribute("aria-expanded")) === "false");
  await button.click();
  check("menu open: sync/export/signout visible", (await shown(page, ".sync-button")) && (await shown(page, ".export-button")) && (await shown(page, ".signout-button")));
  check("aria-expanded=true", (await button.getAttribute("aria-expanded")) === "true");
  const sizes = await page.evaluate(() => [".sync-button", ".export-button", ".signout-button"].map((s) => document.querySelector(s).getBoundingClientRect().height));
  check("menu buttons ≥ 44px", sizes.every((h) => h >= 44), sizes.join(","));
  await page.screenshot({ path: `${SCRATCH}/menu-open-390.png` });
  await page.keyboard.press("Escape");
  check("Escape closes the menu", (await button.getAttribute("aria-expanded")) === "false");
  check("focus returned to the menu button", await page.evaluate(() => document.activeElement?.classList.contains("menu-button")));
  await button.click();
  await page.mouse.click(200, 700);
  check("outside tap closes the menu", (await button.getAttribute("aria-expanded")) === "false");
  await button.click();
  await page.click(".sync-button");
  check("choosing Sync closes the menu", (await button.getAttribute("aria-expanded")) === "false");
  await button.click();
  await page.click('.bottom-nav a[href="?tab=search"]');
  check("switching tab closes the menu", (await button.getAttribute("aria-expanded")) === "false");
  await context.close();
}

if (groups.has("polish")) {
  const { context, page } = await open({ width: 390, height: 844 });
  for (const tab of ["schedule", "book", "search", "alerts"]) {
    await page.goto(`${BASE}?tab=${tab}`);
    await page.waitForSelector(".bottom-nav");
    const report = await page.evaluate(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
      const small = []; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) { const el = walker.currentNode.parentElement; if (!walker.currentNode.textContent.trim() || !el || !visible(el)) continue; const size = parseFloat(getComputedStyle(el).fontSize); const exempt = el.closest("#preview-add-move, .manual-date-day, .manual-date-weekday, .month-day, .month-weekday, .month-legend em"); if (size < 12 && !exempt) small.push(`${size}px ${el.tagName.toLowerCase()}.${el.className}`); }
      const short = [...document.querySelectorAll('button, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea, [role="tab"]')].filter((el) => visible(el) && !el.closest(".bottom-nav, #preview-add-move") && el.getBoundingClientRect().height < 44).map((el) => `${Math.round(el.getBoundingClientRect().height)}px ${el.tagName.toLowerCase()}.${el.className}`);
      const smallInputs = [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea")].filter((el) => visible(el) && !el.closest("#preview-add-move") && parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => `${getComputedStyle(el).fontSize} ${el.tagName.toLowerCase()}.${el.className}`);
      return { small: [...new Set(small)], short: [...new Set(short)], smallInputs: [...new Set(smallInputs)], overflow: document.documentElement.scrollWidth > window.innerWidth };
    });
    check(`${tab}: no text under 12px (cell micro-labels exempt)`, report.small.length === 0, report.small.slice(0, 6).join(" | "));
    check(`${tab}: controls ≥ 44px tall`, report.short.length === 0, report.short.slice(0, 6).join(" | "));
    check(`${tab}: text inputs ≥ 16px`, report.smallInputs.length === 0, report.smallInputs.slice(0, 6).join(" | "));
    check(`${tab}: no horizontal overflow`, !report.overflow);
    await page.screenshot({ path: `${SCRATCH}/polish-${tab}-390.png`, fullPage: true });
  }
  await context.close();
}

if (groups.has("desktop")) {
  const { context, page } = await open({ width: 1280, height: 800 });
  check("desktop: bar hidden", !(await shown(page, ".bottom-nav")));
  check("desktop: menu button hidden", !(await shown(page, ".menu-button")));
  check("desktop: top actions visible", (await shown(page, ".sync-button")) && (await shown(page, ".signout-button")));
  const panels = [".hero", ".booking-panel", ".schedule-panel", ".case-search-panel", ".move-history-panel"];
  const all = await Promise.all(panels.map((p) => shown(page, p)));
  check("desktop: every section visible at once", all.every(Boolean), all.join(","));
  await page.goto(BASE + "?tab=book");
  const again = await Promise.all(panels.map((p) => shown(page, p)));
  check("desktop: ?tab= has no effect", again.every(Boolean));
  await page.screenshot({ path: `${SCRATCH}/desktop-1280.png`, fullPage: true });
  await context.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
```

- [ ] **Step 12: Run the browser checks for this task**

Run (dev server from Task 1 still running; if the Step 10 build replaced `.next`, restart `npm run dev`):
`cd "$SCRATCH/pw" && SCRATCH="$SCRATCH" CHROMIUM_PATH="$CHROMIUM_PATH" node verify.mjs nav,desktop`
Expected: every line `PASS`, final `N/N passed`, exit 0. Fix real failures in the code; do not weaken a check. Look at `$SCRATCH/nav-alerts-390.png` and `$SCRATCH/nav-booking-success-390.png` with the Read tool: the bar is at the bottom, ตาราง/ลงคิว/ค้นหา/แจ้งเตือน readable, selected tab tinted with a pressed pill.

- [ ] **Step 13: Checkpoint**

Run: `npm run lint && npm test`
Expected: clean; all tests pass. If commits are authorised: `git add app tests && git reset app/preview && git commit -m "feat: show one screen at a time with a bottom navigation bar on phones"` (confirm with `git status` that `app/preview` is not staged).

---

### Task 6: Compact top bar with a "เมนู" button (spec §4.4)

**Files:**
- Modify: `app/SchedulerApp.tsx` (state, effect, `<header>` JSX at ~1084–1101, `selectTab`)
- Modify: `app/mobile-shell.css` (append)
- Test: `tests/mobile-shell.test.mjs` (append), `$SCRATCH/pw/verify.mjs` group `menu`

**Interfaces:**
- Consumes: `selectTab` from Task 5 (modified to close the menu).
- Produces: `menuOpen: boolean`, `setMenuOpen`; DOM contract: `button.menu-button[aria-expanded][aria-controls="topbar-menu"]`, `div#topbar-menu.topbar-actions[data-open]`.

- [ ] **Step 1: Append failing source tests**

Append to `tests/mobile-shell.test.mjs`:

```js
test("top bar collapses into an accessible menu disclosure on phones", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const css = await read("app/mobile-shell.css");
  assert.match(app, /className="menu-button" type="button" aria-expanded=\{menuOpen\} aria-controls="topbar-menu"/);
  assert.match(app, /id="topbar-menu" className="topbar-actions" data-open=\{menuOpen\}/);
  assert.match(app, /event\.key !== "Escape"/);
  assert.match(app, /menuButtonRef\.current\?\.focus\(\)/);
  assert.match(css, /\.menu-button\s*\{[^}]*display: none/);
  assert.match(css, /\.topbar \.topbar-actions\[data-open="true"\]/);
  assert.match(app, /Sync ทันที/);
});
```
Run: `node --test tests/mobile-shell.test.mjs` → the new test FAILS.

- [ ] **Step 2: Add menu state and effects**

In `SchedulerApp.tsx`, insert directly **before** the `const searchParams = useSearchParams();` line (added in Task 5):

```tsx
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
```
Change `selectTab`'s body to start with `setMenuOpen(false);` (the callback's dependency list stays `[]` because state setters are stable). Then, after the `useEffect` that focuses the screen (Task 5 Step 5), add:

```tsx
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [menuOpen]);
```

- [ ] **Step 3: Update the header JSX**

In the `<header className="topbar">` block, replace `<div className="topbar-actions">` with:

```tsx
        <button ref={menuButtonRef} className="menu-button" type="button" aria-expanded={menuOpen} aria-controls="topbar-menu" onClick={() => setMenuOpen((open) => !open)}>เมนู</button>
        <div ref={menuRef} id="topbar-menu" className="topbar-actions" data-open={menuOpen}>
```
and replace the two handlers:
- `onClick={syncCalendar}` on `.sync-button` → `onClick={() => { setMenuOpen(false); void syncCalendar(); }}`
- `onClick={() => void exportWaitingTime()}` on `.export-button` (the one in the header, not the one in `.wait-time-export`) → `onClick={() => { setMenuOpen(false); void exportWaitingTime(); }}`

(If `syncCalendar` does not return a promise, `void` is still valid. Check the actual signature with `grep -n "function syncCalendar" app/SchedulerApp.tsx` before editing.)

- [ ] **Step 4: Append the menu styles**

Append to `app/mobile-shell.css`:

```css
.menu-button { display: none; }

@media (max-width: 1000px) {
  .topbar { position: relative; min-height: 76px; padding: 12px 0; flex-wrap: nowrap; align-items: center; }
  .topbar .brand { width: auto; min-width: 0; }
  .menu-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    padding: 0 20px;
    border-radius: 999px;
    color: var(--ink);
    background: var(--glass);
    box-shadow: var(--glass-highlight);
    font-size: 14px;
    font-weight: 800;
  }
  .menu-button[aria-expanded="true"] { box-shadow: var(--pressed); }
  .topbar .topbar-actions { display: none; }
  .topbar .topbar-actions[data-open="true"] {
    position: absolute;
    top: calc(100% - 6px);
    right: 0;
    z-index: 60;
    width: min(320px, 100%);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    padding: 14px;
    border-radius: 22px;
    background: var(--soft-base);
    box-shadow: var(--raised-large);
  }
  .topbar .topbar-actions .calendar-pill { max-width: none; font-size: 12px; }
  .topbar .topbar-actions .sync-button,
  .topbar .topbar-actions .export-button,
  .topbar .topbar-actions .signout-button { min-height: 44px; height: auto; font-size: 14px; }
  .topbar .topbar-actions form { display: flex; }
  .topbar .topbar-actions form .signout-button { flex: 1; }
}
```

- [ ] **Step 5: Run source tests, lint, and the browser group**

Run: `node --test tests/mobile-shell.test.mjs && npm run lint`
Expected: PASS.
Run: `cd "$SCRATCH/pw" && SCRATCH="$SCRATCH" CHROMIUM_PATH="$CHROMIUM_PATH" node verify.mjs menu,nav,desktop`
Expected: all PASS (the `nav` and `desktop` groups re-run to prove nothing regressed; in the `nav` group the booking-success check clicks the in-page sync dialog, not the menu). Read `$SCRATCH/menu-open-390.png`: the menu lists calendar status, Sync, Export, ออกจากระบบ and sits above content, below dialogs.

- [ ] **Step 6: Checkpoint**

Run: `npm test`
Expected: all pass. If commits are authorised: `git add app tests && git reset app/preview && git commit -m "feat: collapse the top bar actions into a menu on phones"`.

---

### Task 7: Targeted mobile fixes confirmed by the review (item 2)

**Files:**
- Modify: `app/mobile-shell.css` (append)
- Modify: `docs/superpowers/specs/2026-10-08-ui-review-findings.md` (mark rows fixed / not fixed with the after-fix numbers)
- Test: `tests/mobile-shell.test.mjs` (append), `$SCRATCH/pw/verify.mjs` group `polish`

**Interfaces:**
- Consumes: `docs/.../ui-review-findings.md` rows planned for "Task 7" and the baseline `$SCRATCH/pw/audit.json`.
- Produces: phone (≤ 650px) floors: text ≥ 12px (calendar-cell micro-labels ≥ 10px), controls ≥ 44px, text inputs 16px.

- [ ] **Step 1: Run the polish group first to see it fail**

Run: `cd "$SCRATCH/pw" && SCRATCH="$SCRATCH" CHROMIUM_PATH="$CHROMIUM_PATH" node verify.mjs polish`
Expected: many `FAIL … no text under 12px` / `controls ≥ 44px` / `text inputs ≥ 16px` lines (this is the "red" baseline). Keep the output.

- [ ] **Step 2: Append the polish stylesheet**

Append to `app/mobile-shell.css`:

```css
/* Phone polish (≤ 650px): readable text, comfortable targets, no iOS focus-zoom. */
@media (max-width: 650px) {
  /* Text floor: 12px */
  .eyebrow, .presence-status, .setup-banner p, .last-sync, .queue-conflict-heading > span, .queue-conflict-heading p,
  .queue-suggestion-list > strong, .queue-suggestion-list > button > span:last-child, .queue-suggestion-list b,
  .queue-suggestion-list small, .queue-suggestion-empty, .queue-conflict-footnote,
  .sync-confirm-dialog > span:not(.sync-confirm-icon), .sync-confirm-dialog p, .step, .diagnosis-badge,
  .field span, .extra-form label span, .neoadjuvant-choice, .field-help, .staff-selector legend,
  .staff-selector label, .staff-selector small, .staff-queue-preference small, .staff-smart-heading span,
  .staff-smart-heading > b, .staff-smart-date small, .staff-smart-list dt, .staff-smart-privacy,
  .staff-queue-empty, .manual-date-calendar-heading span, .manual-date-calendar-heading small,
  .manual-date-toolbar strong, .manual-date-summary, .manual-date-legend, .manual-date-loading,
  .wait-time-card span, .wait-time-card p, .cancer-mode legend, .mode-options small, .cancer-suggestion span,
  .cancer-suggestion small, .privacy-note, .wait-time-export strong, .wait-time-export small,
  .wait-time-export label span, .extra-fixed-capacity span, .extra-fixed-capacity small, .date-block span,
  .day-title span, .warning-line, .extra-line, .closure-line, .mini-bookings > div > span:first-child,
  .mini-bookings strong, .mini-bookings small, .full-label, .month-day > span, .month-day-summary > div span,
  .month-day-summary p, .month-day-summary > small, .month-closure-summary b, .month-closure-summary span,
  .month-bookings-heading strong, .month-bookings-heading span, .month-booking-slot strong,
  .month-booking-slot small, .month-booking-detail strong, .month-booking-detail span,
  .month-booking-detail small, .month-bookings-empty, .month-legend, .closure-form-heading small,
  .closure-form label span, .closure-list-toolbar strong, .closure-list > p, .closure-date span,
  .closure-detail strong, .closure-detail span, .closure-detail small, .closure-affected-list b,
  .closure-affected-list span, .closure-affected-list small, .search-scope, .history-count,
  .case-search-form > label, .case-identity strong, .case-current strong, .case-identity small,
  .case-current small, .case-operation small, .case-operation, .select-case, .move-form label,
  .move-form > small, .case-empty, .move-history-list strong, .move-history-list small,
  .move-history-list p, .move-history-list time, footer, .calendar-pill, .delete-case-summary span,
  .delete-case-summary small, .delete-hn-form label, .delete-hn-form p {
    font-size: 12px;
  }

  /* Calendar cells are ~44px wide: micro-labels keep a 10px floor. */
  .manual-date-weekday, .manual-date-day, .manual-date-day small, .month-weekday, .month-day b,
  .month-day.closed em, .month-legend em {
    font-size: 10px;
  }

  /* Touch targets: 44px */
  .sync-button, .export-button, .signout-button, .setup-banner > button, .text-button,
  .schedule-tabs button, .staff-queue-preference button, .date-entry-toggle button, .extra-form button,
  .wait-time-export button, .month-toolbar button, .closure-form-actions button,
  .closure-row-actions button, .closure-confirm-actions button, .case-search-form button,
  .move-form button, .delete-confirm-actions button, .queue-suggestion-list > button {
    min-height: 44px;
    font-size: 12px;
    line-height: 1.2;
  }
  .schedule-tabs button { padding: 6px 4px; }

  /* Inputs: 44px tall and 16px so iOS Safari does not zoom on focus */
  .field input, .field textarea, .field select, .extra-form input, .wait-time-export input,
  .closure-form input, .closure-form textarea, .closure-list-toolbar input, .case-search-form input,
  .move-form select, .delete-hn-form input {
    min-height: 44px;
    font-size: 16px;
  }
}
```

- [ ] **Step 3: Append the source test**

Append to `tests/mobile-shell.test.mjs`:

```js
test("phone polish sets the text, target and input-zoom floors", async () => {
  const css = await read("app/mobile-shell.css");
  const polish = css.slice(css.indexOf("Phone polish"));
  assert.match(polish, /@media \(max-width: 650px\)/);
  assert.match(polish, /\.field span[\s\S]*?\{\s*font-size: 12px;/);
  assert.match(polish, /min-height: 44px;\s*font-size: 12px/);
  assert.match(polish, /\.field input[\s\S]*?\{\s*min-height: 44px;\s*font-size: 16px;/);
  assert.match(polish, /\.month-legend em \{\s*font-size: 10px;/);
});
```

- [ ] **Step 4: Run tests and the polish group**

Run: `node --test tests/mobile-shell.test.mjs && npm run lint`
Expected: PASS.
Run: `cd "$SCRATCH/pw" && SCRATCH="$SCRATCH" CHROMIUM_PATH="$CHROMIUM_PATH" node verify.mjs polish`
Expected: all PASS. If a row still fails, the failure line names the class: add exactly that selector to the matching block above (text list, target list, or input list) and re-run. If a floor breaks a layout (overflow, clipped text), open `$SCRATCH/polish-<tab>-390.png`, and fix with the smallest local override (for example `min-width: 0; overflow-wrap: anywhere;` on the offending class), then re-run all groups.

- [ ] **Step 5: Look at the result and update the findings**

Read the four screenshots `$SCRATCH/polish-schedule-390.png`, `polish-book-390.png`, `polish-search-390.png`, `polish-alerts-390.png`. For every row in `ui-review-findings.md` marked Task 7, set status "fixed (verified `verify.mjs polish`)" or write what remains and why. Re-run `audit.mjs` and add a one-line before/after count of small-text and small-target entries at 390px.

- [ ] **Step 6: Checkpoint**

Run: `npm run lint && npm test`
Expected: clean; all pass. If commits are authorised: `git add app tests docs && git reset app/preview && git commit -m "fix: raise phone text, target and input sizes"`.

---

### Task 8: Final verification and cleanup

**Files:**
- Delete: `app/preview/` (entire directory)
- Modify: `README.md` (one short paragraph)

**Interfaces:**
- Consumes: everything above. Produces: a clean working tree for the user to review (no preview route).

- [ ] **Step 1: Run the full browser suite**

Run: `cd "$SCRATCH/pw" && SCRATCH="$SCRATCH" CHROMIUM_PATH="$CHROMIUM_PATH" node verify.mjs nav,menu,polish,desktop`
Expected: all PASS, exit 0. Also confirm in the output that `desktop: every section visible at once` passed (desktop unchanged).

- [ ] **Step 2 (optional, user action): check on a real iPhone**

Because `/preview` needs no login, the user can load it on an iPhone to see real home-indicator clearance. Temporarily add `allowedDevOrigins: ["<mac-ip>"]` to `next.config.ts`, run `npm run dev -- -H 0.0.0.0`, open `http://<mac-ip>:3000/preview?tab=book` on the phone. **Revert `next.config.ts` afterwards** (`git diff next.config.ts` must be empty before finishing). Skip this step if the user does not want it.

- [ ] **Step 3: Stop the dev server and remove the preview route**

```bash
rm -rf app/preview
git status --short
```
Expected: no `app/preview` entry; `next.config.ts` unchanged.

- [ ] **Step 4: Document the feature in the README**

Append to `README.md` after the "กติกาหลัก" list:

```markdown
## การใช้งานบนมือถือและแท็บเล็ต

บนหน้าจอกว้างไม่เกิน 1000px ระบบแสดงทีละหน้าจอ และมีแถบเมนูด้านล่าง 4 หน้า: **ตาราง** (`?tab=schedule`), **ลงคิว** (`?tab=book`), **ค้นหา** (`?tab=search`) และ **แจ้งเตือน** (`?tab=alerts`) ตัวเลขบนแจ้งเตือนคือการสลับวันที่ยังไม่ได้ดูบนเครื่องนี้ (เก็บใน localStorage ของเบราว์เซอร์) ส่วนปุ่ม Sync, Export และออกจากระบบอยู่ในปุ่ม "เมนู" ด้านบน หน้าจอเดสก์ท็อปแสดงทุกส่วนพร้อมกันเหมือนเดิม
```

- [ ] **Step 5: Final automated checks**

Run: `npm run lint && npm run build && npm test`
Expected: lint clean, build succeeds (route list shows `/` as dynamic, no `/preview`), all tests pass (22 original + 10 nav + the mobile-shell tests).

- [ ] **Step 6: Report to the user**

Summarise: what changed, files touched (`git status --short`), test counts, the findings document path, anything not done (iPhone check if skipped; items from the review marked "not planned"), and that nothing is committed or deployed. Ask whether to commit (on a `feat/bottom-nav` branch) and whether to deploy; do neither without an answer.

- [ ] **Step 7: Checkpoint**

`git status --short` lists only intended files (`app/BottomNav.tsx`, `app/mobile-shell.css`, `app/useUnseenMoves.ts`, `app/lib/nav.ts`, `app/layout.tsx`, `app/page.tsx`, `app/SchedulerApp.tsx`, `tests/nav.test.mjs`, `tests/mobile-shell.test.mjs`, `README.md`, `design-system/`, `docs/`, plus the pre-existing untracked `AGENTS.md`/`CLAUDE.md`).
