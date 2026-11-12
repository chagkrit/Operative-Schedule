# P1 — Perceived Speed & Trust (PR-A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OR Queue feel fast and trustworthy: skeleton on first load, quiet background refresh with guards, a freshness line, stale-selection notes, Aurora confirm dialogs instead of `window.confirm`, and a non-blocking post-booking message instead of the Sync modal.

**Architecture:** Pure timing/label logic goes in a new `app/lib/refresh.ts` (unit-tested with `node --test`). Two small presentational components (`app/Skeleton.tsx`, `app/ConfirmDialog.tsx`) are new files; `app/SchedulerApp.tsx` only gains wiring (no restructuring). Styling goes at the end of `app/aurora.css` using existing tokens.

**Tech Stack:** Next.js 16 (App Router, read `node_modules/next/dist/docs/` before using any Next API), React 19, TypeScript, plain CSS, `node --test` source-text + unit tests.

**Spec:** `docs/superpowers/specs/2026-11-12-p1-p2-world-class-feel-design.md` (§4 = this PR; §7 owner decisions; §8 Claude's calls)

## Global Constraints

- **No optimistic updates.** Nothing appears in the queue until the server has confirmed it and a reload has returned it.
- Do not change any API route, `app/lib/queue.ts`, `app/lib/destination.ts`, `app/lib/calendar*.ts`, `auth.ts`, or the HN-verified case delete dialog.
- Do not split or restructure `SchedulerApp.tsx`; only add state, handlers and JSX wiring.
- Spec §4.2's optional "highlight the just-saved row" is intentionally left out (YAGNI).
- Do not add a service worker or any client-side storage of patient data.
- Timing values (spec §4.3/§4.4, Claude's calls): throttle **60 s**, interval **5 min** while visible, form-idle **3 min**, stale warning after **10 min**.
- Bangkok time for every displayed time: `Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" })`.
- Respect `prefers-reduced-motion` for every new animation.
- Repo checks before every commit: `npm test`, `npx tsc --noEmit`, `npx eslint auth.ts app scripts tests`. If `next dev` was run, `git checkout next-env.d.ts`.
- Work on branch `feat/p1-perceived-speed`. Never push or merge without the owner's go.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01PFJ12YBXX3uCgDkEsPxXDA
  ```

Exact Thai copy (spec):
- Freshness, fresh: `อัปเดตล่าสุด {HH:MM} น. · ข้อมูลเดิม {N} เคส`
- Freshness, older than 10 min (amber): `อัปเดตเมื่อ {n} นาทีที่แล้ว · ข้อมูลเดิม {N} เคส`
- Freshness, last quiet refresh failed: `เชื่อมต่อไม่ได้ · ข้อมูลล่าสุดเมื่อ {HH:MM} น.` + button `ลองใหม่`
- Selected date gone: `วันที่เลือกเต็มหรือปิดแล้ว กรุณาเลือกวันใหม่`
- Selected case changed elsewhere: `เคสนี้ถูกแก้จากอีกเครื่อง กรุณาค้นหาใหม่`
- Post-booking success: `บันทึกคิวแล้ว · ยืนยันกับ Google Calendar แล้ว • {date} • {room}`
- Post-booking saved but refresh failed: `บันทึกคิวแล้ว แต่ยังยืนยันกับ Google Calendar ไม่ได้ • {date} • {room} — กด "ลองใหม่"`
- Confirm dialog buttons: `ยกเลิก` / `ลบ`

## Review Focus

1. **Flaky hospital Wi-Fi:** a quiet refresh that fails (network/5xx) must never raise the red `role="alert"` notice; only the freshness line changes. → test in Task 3.
2. **Signed-out session or dead Calendar token (401) during a quiet refresh:** must show the banner + notice like today, not stay silent. → test in Task 3.
3. **Shared phone with an abandoned half-filled form:** refresh must resume 3 min after the last edit. → unit test in Task 1.
4. **Two quick triggers (focus + visibilitychange fire together):** only one request. → unit test (in-flight + throttle) in Task 1.
5. **Selected case is in the past or outside the loaded horizon:** must not be flagged as "changed elsewhere" just because it is not in `data.bookings`. → test in Task 5.

---

### Task 1: Pure refresh logic (`app/lib/refresh.ts`)

**Files:**
- Create: `app/lib/refresh.ts`
- Test: `tests/refresh.test.mjs`

**Interfaces:**
- Produces:
  - `export const REFRESH_THROTTLE_MS = 60_000; REFRESH_INTERVAL_MS = 300_000; FORM_IDLE_MS = 180_000; STALE_AFTER_MS = 600_000;`
  - `export type RefreshGate = { now: number; lastLoadedAt: number | null; inFlight: boolean; busy: boolean; dialogOpen: boolean; lastFormEditAt: number | null };`
  - `export function shouldRefreshQuietly(gate: RefreshGate): boolean` — false if `inFlight || busy || dialogOpen`, or `lastLoadedAt !== null && now - lastLoadedAt < REFRESH_THROTTLE_MS`, or `lastFormEditAt !== null && now - lastFormEditAt < FORM_IDLE_MS`; else true.
  - `export type Freshness = { tone: "ok" | "stale" | "failed"; text: string };`
  - `export function freshnessLabel(now: number, lastSyncedAt: number, importedCount: number, failed: boolean): Freshness` — uses the exact copy above; minutes = `Math.floor((now - lastSyncedAt) / 60_000)`.

- [ ] **Step 1: Write the failing tests** in `tests/refresh.test.mjs` (import `./ts-resolve.mjs` first, then `await import("../app/lib/refresh.ts")`, like `tests/minutes.test.mjs`):
  - `shouldRefreshQuietly` true for `{ now: 1e9, lastLoadedAt: 1e9 - 61_000, inFlight: false, busy: false, dialogOpen: false, lastFormEditAt: null }`.
  - false when `lastLoadedAt = now - 59_000`; false when `inFlight`; false when `busy`; false when `dialogOpen`.
  - false when `lastFormEditAt = now - 179_000`; true when `lastFormEditAt = now - 181_000`.
  - true when `lastLoadedAt` is `null`.
  - `freshnessLabel(t, t - 5*60_000, 12, false)` → `tone "ok"`, text matches `/^อัปเดตล่าสุด \d{2}:\d{2} น\. · ข้อมูลเดิม 12 เคส$/`.
  - `freshnessLabel(t, t - 12*60_000, 12, false)` → `{ tone: "stale", text: "อัปเดตเมื่อ 12 นาทีที่แล้ว · ข้อมูลเดิม 12 เคส" }`.
  - `freshnessLabel(t, t - 60_000, 12, true)` → `tone "failed"`, text matches `/^เชื่อมต่อไม่ได้ · ข้อมูลล่าสุดเมื่อ \d{2}:\d{2} น\.$/`.
  - Constants equal 60_000 / 300_000 / 180_000 / 600_000.
- [ ] **Step 2:** `node --test tests/refresh.test.mjs` → FAIL (module not found).
- [ ] **Step 3:** Implement `app/lib/refresh.ts` (no imports).
- [ ] **Step 4:** `node --test tests/refresh.test.mjs` → PASS.
- [ ] **Step 5:** Commit `feat: pure quiet-refresh gate and freshness label`.

### Task 2: First-load skeleton

**Files:**
- Create: `app/Skeleton.tsx`
- Modify: `app/SchedulerApp.tsx` (~1757 manual-date placeholder, ~1841 list placeholder), `app/aurora.css` (append)
- Test: `tests/p1-feel.test.mjs` (new; source-text style like `tests/app-rules.test.mjs`)

**Interfaces:**
- Produces: `export function QueueSkeleton(): JSX.Element` and `export function CalendarSkeleton(): JSX.Element` in `app/Skeleton.tsx`. Each renders a container with `aria-busy="true"` and one visually hidden `<span role="status">` text (`กำลังโหลดคิว…` / `กำลังโหลดปฏิทินคิวผ่าตัด…`). Blocks use class `orq-skeleton`.

- [ ] **Step 1: Failing test** `"shows skeletons only on the first load"`: `SchedulerApp.tsx` matches `/loading && !data \? <QueueSkeleton \/>/` and contains `<CalendarSkeleton />`; does not match `/className="empty-state">กำลังโหลดคิว…/`; `aurora.css` matches `/\.orq-skeleton/` and `/prefers-reduced-motion[\s\S]*orq-skeleton/`.
- [ ] **Step 2:** `node --test tests/p1-feel.test.mjs` → FAIL.
- [ ] **Step 3:** Build `Skeleton.tsx` (QueueSkeleton: one day-header bar + 4 row bars; CalendarSkeleton: 7×5 grid of cells). Wire: list placeholder becomes `{loading && !data ? <QueueSkeleton /> : null}`; the manual-date fallback `<p className="manual-date-loading">…` becomes `<CalendarSkeleton />`. Change the "ยังไม่มีวันผ่าตัด…" condition to `!loading && data && upcomingDays.length === 0` so it can't flash during a later reload. CSS: `--glass-a` fill, `--hairline` border, 1.4 s shimmer gradient; under reduced-motion no animation. Add a `.visually-hidden` utility only if `globals.css` lacks one (grep first).
- [ ] **Step 4:** Tests pass + repo checks.
- [ ] **Step 5:** Commit `feat: skeleton placeholders on first load`.

### Task 3: Quiet background refresh

**Files:**
- Modify: `app/SchedulerApp.tsx` (`loadSchedule` ~617, effects after ~641, `syncCalendar` ~952)
- Test: `tests/p1-feel.test.mjs`

**Interfaces:**
- Consumes: `shouldRefreshQuietly`, `REFRESH_INTERVAL_MS` (Task 1).
- Produces (used by Tasks 4, 7): `loadSchedule(options?: { showSuccess?: boolean; quiet?: boolean }): Promise<boolean>`; state `refreshFailed: boolean` (true after a failed quiet load, false after any successful load); ref `lastLoadedAtRef: MutableRefObject<number | null>`.

- [ ] **Step 1: Failing tests:**
  - `"quiet refresh never raises the alert notice"`: slice the source from `const loadSchedule = useCallback` to the next `}, []);` and assert on that slice: matches `/if \(quiet\) \{\s*setRefreshFailed\(true\)/` (the quiet branch returns before any notice), matches `/status === 401/`, and matches `/setRefreshFailed\(false\)/`.
  - `"quiet refresh is gated and event-driven"`: matches `/shouldRefreshQuietly\(/`, `/addEventListener\("visibilitychange"/` (a second occurrence besides presence), `/addEventListener\("focus"/`, `/addEventListener\("online"/`, `/REFRESH_INTERVAL_MS/`, `/lastFormEditAtRef/`.
  - Update the existing call `loadSchedule(true)` expectation if any test asserts it (grep `loadSchedule(` in tests first).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - `loadSchedule({ showSuccess = false, quiet = false } = {})`. On non-OK: if `response.status === 401` → behave like today (set `calendarError` + error notice) even when quiet; else if `quiet` → `setRefreshFailed(true)` only; else today's behaviour. Network exceptions follow the same quiet rule. `setLoading(false)` stays in `finally` (harmless). On success: `setRefreshFailed(false)`, `lastLoadedAtRef.current = Date.now()`.
  - `syncCalendar` calls `loadSchedule({ showSuccess: true })`; all other existing calls stay non-quiet.
  - `lastFormEditAtRef`: a `useEffect` on `[form]` sets `lastFormEditAtRef.current = form === EMPTY_FORM ? null : Date.now()`.
  - `inFlightRef` set around the quiet call.
  - `busy` = any of `saving, moving, deleting, editSaving, closureSaving, unavailabilitySaving, syncing, exporting`; `dialogOpen` = any of `bookingConflict, pendingClosure, pendingUnavailability, deleteDialog, editDialog, confirmDialog` (`confirmDialog` arrives in Task 6 — add it to this list then). Keep these in a ref updated each render so the listeners read current values without re-subscribing.
  - One effect registers `visibilitychange` (only when `visible`), `focus`, `online`, and a `setInterval(REFRESH_INTERVAL_MS)` that does nothing when `document.visibilityState !== "visible"`; each calls `tryQuietRefresh()` which checks `shouldRefreshQuietly` then `loadSchedule({ quiet: true })`. Clean up on unmount.
  - Leave the staff-schedule effect's `lastSyncedAt` dependency as is (spec allows it with the 60 s throttle).
- [ ] **Step 4:** Tests pass + repo checks.
- [ ] **Step 5:** Commit `feat: quiet background refresh with guards`.

### Task 4: Freshness line

**Files:**
- Modify: `app/SchedulerApp.tsx` (~1503 `p.last-sync`), `app/aurora.css`
- Test: `tests/p1-feel.test.mjs`

**Interfaces:**
- Consumes: `freshnessLabel` (Task 1), `refreshFailed`, `syncCalendar` (Task 3).

- [ ] **Step 1: Failing test** `"freshness line uses the shared label and offers retry"`: matches `/freshnessLabel\(/`, `/className=\{`last-sync \$\{/` (tone class), `/>ลองใหม่</`; the old literal `อัปเดตจาก Google Calendar ล่าสุด` is gone.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Keep the render condition `lastSyncedAt && data?.calendarConnected`. Add a `now` state ticked every 60 s (one `setInterval`) so "n นาทีที่แล้ว" advances. Render `<p className={`last-sync ${tone}`} role="status">{text}{tone === "failed" && <button type="button" className="text-button" onClick={() => void syncCalendar()} disabled={syncing}>ลองใหม่</button>}</p>`. CSS: `.last-sync.stale, .last-sync.failed { color: var(--amber) }`.
- [ ] **Step 4:** Tests pass + repo checks.
- [ ] **Step 5:** Commit `feat: freshness line with stale and failed states`.

### Task 5: Stale selected date and stale selected case

**Files:**
- Modify: `app/SchedulerApp.tsx` (derived values near ~863; date field JSX near ~1750; selected-case card + its move/edit/delete buttons near ~1940–1975)
- Test: `tests/p1-feel.test.mjs`

**Interfaces:**
- Produces: `const requestedDateStale: boolean`, `const selectedCaseStale: boolean`.

- [ ] **Step 1: Failing tests:**
  - `"keeps a refreshed-away date and says so"`: matches `/const requestedDateStale = /` and the copy `วันที่เลือกเต็มหรือปิดแล้ว กรุณาเลือกวันใหม่`.
  - `"flags a case changed on another device, but not past cases"`: matches `/const selectedCaseStale = /`, `/selectedCase\.scheduleDate >= data\.horizonStart/` inside that expression, the copy `เคสนี้ถูกแก้จากอีกเครื่อง กรุณาค้นหาใหม่`, and `/disabled=\{[^}]*selectedCaseStale/` at least 3 times (move submit, edit, delete).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:**
  - `requestedDateStale = Boolean(data && form.requestedDate && !(cancer && form.cancerSchedulingMode === "earliest") && !openDays.some((d) => d.date === form.requestedDate && d.queueType === (form.requestedQueueType || "OR17")))`. Show the note as `<small className="field-help field-warning" role="status">` under the date field. Do **not** clear the value.
  - `selectedCaseStale = Boolean(data && selectedCase && selectedCase.scheduleDate >= data.horizonStart && !data.bookings.some((b) => b.id === selectedCase.id && b.scheduleDate === selectedCase.scheduleDate && b.queueType === selectedCase.queueType))`. First confirm that search-result `id` and `data.bookings[].id` are the same identifier (compare `app/api/cases/search/route.ts` with `app/api/schedule/route.ts`); if not, match on the field that is shared and note it in the commit message. Show the note on the selected-case card (`role="status"`), add `|| selectedCaseStale` to the `disabled` of the move submit, duration edit and delete buttons.
  - CSS `.field-warning { color: var(--amber) }`.
- [ ] **Step 4:** Tests pass + repo checks.
- [ ] **Step 5:** Commit `feat: flag selections that a refresh made stale`.

### Task 6: Aurora confirm dialog replaces `window.confirm`

**Files:**
- Create: `app/ConfirmDialog.tsx`
- Modify: `app/SchedulerApp.tsx` (`deleteClosure` ~1154, `deleteUnavailability` ~1252, shared modal effect ~643–691, JSX near other dialogs ~1539), `tests/staff-unavailability-wiring.test.mjs:124`
- Test: `tests/p1-feel.test.mjs`

**Interfaces:**
- Produces: `export default function ConfirmDialog(props: { title: string; message: string; confirmLabel: string; busy: boolean; cancelRef: RefObject<HTMLButtonElement | null>; onCancel: () => void; onConfirm: () => void }): JSX.Element` — markup reuses `queue-conflict-backdrop` / `queue-conflict-dialog`, `role="alertdialog"`, `aria-modal="true"`, `aria-labelledby`/`aria-describedby`, buttons `ยกเลิก` (ref = `cancelRef`) and a danger-styled `{confirmLabel}`.
- State in SchedulerApp: `confirmDialog: { title: string; message: string; confirmLabel: string; action: () => Promise<void> } | null`; `confirmTriggerRef: MutableRefObject<HTMLButtonElement | null>`.

- [ ] **Step 1: Failing tests / test update:**
  - `p1-feel`: `SchedulerApp.tsx` does not match `/window\.confirm/`; matches `/<ConfirmDialog/`, `/setConfirmDialog\(/` at least twice; `ConfirmDialog.tsx` matches `/role="alertdialog"/` and `/aria-modal="true"/`.
  - In `tests/staff-unavailability-wiring.test.mjs` replace line 124 with `assert.match(app, /ลบวันที่ staff ไม่ว่าง \$\{entry\.staff\}/); assert.doesNotMatch(app, /window\.confirm/);`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** `deleteClosure(closure, trigger)` / `deleteUnavailability(entry, trigger)` now open the dialog (same message text as today's confirm, title `ลบวันปิดรับคิว` / `ลบวันที่ staff ไม่ว่าง`, confirmLabel `ลบ`) and move today's fetch body into `action`. Row buttons pass `event.currentTarget`. Confirm runs `action`, then closes; the busy flag is the existing `closureSaving` / `unavailabilitySaving`. Shared modal effect: add `confirmDialog` to the open check, Escape closes it (unless busy) and returns focus to `confirmTriggerRef`, initial focus goes to `cancelRef`, add it to the dependency list. Add `confirmDialog` to Task 3's `dialogOpen` list.
- [ ] **Step 4:** Tests pass + repo checks.
- [ ] **Step 5:** Commit `feat: Aurora confirm dialog for closure and unavailability deletes`.

### Task 7: Post-booking Sync modal → non-blocking message

**Files:**
- Modify: `app/SchedulerApp.tsx` (`showSyncPrompt` state ~547, `confirmSyncAfterBooking` ~962, `submitBooking` success path ~1072–1078, modal JSX ~1539–1549, shared modal effect refs), `tests/app-rules.test.mjs:274`
- Test: `tests/p1-feel.test.mjs`

**Interfaces:**
- Consumes: `loadSchedule({ quiet: true })` (Task 3).

- [ ] **Step 1: Failing tests / test update:**
  - `p1-feel`: no match for `/showSyncPrompt/`, `/confirmSyncAfterBooking/`, `/syncPromptButtonRef/`; matches `/ยืนยันกับ Google Calendar แล้ว/` and `/แต่ยังยืนยันกับ Google Calendar ไม่ได้/`.
  - In `tests/app-rules.test.mjs` replace the `กด Sync ทันที เพื่อบันทึกลงใน Calendar` assertion with `assert.match(app, /บันทึกคิวแล้ว · ยืนยันกับ Google Calendar แล้ว/);`. Keep the `Sync ทันที` assertions at line 34 and in `tests/mobile-shell.test.mjs:106` (menu button stays).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** In `submitBooking` success: compute `room` and `dateText` as today, `setBookingConflict(null)`, `setForm(EMPTY_FORM)`, then `const confirmed = await loadSchedule({ quiet: true });` and set the success notice with the confirmed / not-confirmed copy. Remove the modal and everything that only served it. Keep the mobile `selectTab("schedule", { focus: false })`.
- [ ] **Step 4:** Tests pass + repo checks.
- [ ] **Step 5:** Commit `feat: replace post-booking Sync modal with a confirmed message`.

### Task 8: Inline busy spinners

**Files:**
- Modify: `app/SchedulerApp.tsx` (the busy buttons: booking submit, `editSaving` submit ~1616, closure submit ~1874, unavailability submit ~1904, search ~1937, move ~1970, sync menu button, delete-case confirm), `app/aurora.css`
- Test: `tests/p1-feel.test.mjs`

- [ ] **Step 1: Failing test** `"busy buttons announce and show a spinner"`: at least 6 matches of `/aria-busy=\{/` in `SchedulerApp.tsx`; `aurora.css` matches `/button\[aria-busy="true"\]::before/` and a reduced-motion rule that removes its animation.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add `aria-busy={flag}` next to each existing `disabled={flag…}` (keep current busy labels). CSS: 14 px ring spinner via `::before` using `currentColor`, `animation: orq-spin .8s linear infinite`; reduced-motion → `animation: none`.
- [ ] **Step 4:** Tests pass + repo checks.
- [ ] **Step 5:** Commit `feat: inline busy spinners on saving buttons`.

### Task 9: Whole-branch verification and PR (push only on owner go)

- [ ] **Step 1:** `npm test` → all pass (125 existing + new); `npx tsc --noEmit` → no output; `npx eslint auth.ts app scripts tests` → no output; `npx next build` → succeeds. Revert `next-env.d.ts` if changed.
- [ ] **Step 2:** Visual check in WebKit at 390×844 (Playwright `playwright-core` at `/opt/homebrew/lib/node_modules/rea-agents/node_modules/playwright-core`, WebKit `~/Library/Caches/ms-playwright/webkit-2370/pw_run.sh`): a static HTML in the session scratchpad that links the four app CSS files and contains the markup of QueueSkeleton, the freshness line in ok/stale/failed, the ConfirmDialog, and a busy button. Screenshot light theme; check no horizontal overflow and the dialog sits above the glass panels.
- [ ] **Step 3:** Write a dated section in `HANDOFF_2026-11-12.md` (commits, test counts, what is unverified on a real iPhone, rollback = Vercel promote `2493de6`).
- [ ] **Step 4:** Ask the owner for the go. On go: `gh auth switch -u chagkrit` → `git push -u origin feat/p1-perceived-speed` → PR to `main` (body ends with the Claude Code footer) → wait for the Vercel preview → owner checks on iPhone (first load, leave and return to the app after >1 min, delete a closure, make a booking) → merge only on the owner's word → switch gh back to the previously active account.
