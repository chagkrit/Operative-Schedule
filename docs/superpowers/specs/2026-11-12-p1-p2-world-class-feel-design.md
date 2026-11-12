# P1 + P2 — "World-class feel" for OR Queue

Date: 2026-11-12
Status: APPROVED by owner 2026-11-12 ("ทำตามที่แนะนำทั้ง 3 ข้อ")
Ships as two separate PRs: **PR-A = P1 (perceived speed + trust)**, then **PR-B = P2 (installable app)**.

**สรุปภาษาไทย:** ให้แอปรู้สึกเร็วและน่าเชื่อถือขึ้น (P1) แล้วติดตั้งเป็นไอคอนบนหน้าจอ iPhone ได้ (P2) โดยไม่แตะกฎจัดคิวหรือการเชื่อม Google Calendar ไม่มี optimistic update (ไม่แสดงเคสก่อนที่ server ยืนยัน) เพราะ server เป็นตัวตัดสิน 360 นาที, ช่องชน และวันที่ในโหมด "เร็วที่สุด" ถ้าแสดงล่วงหน้าแล้วโดนปฏิเสธจะทำให้เข้าใจผิดเรื่องคิวผู้ป่วย

## 1. Intent

The app works and looks modern after the Aurora redesign (main `2493de6`). It does not yet *feel* like a world-class app:

- On first load the header and booking form render, but the queue list and the manual-date calendar show only the plain texts "กำลังโหลดคิว…" / "กำลังโหลดปฏิทินคิวผ่าตัด…" (`SchedulerApp.tsx` ~1841, ~1757).
- Data only refreshes when someone presses "↻ Sync ทันที". The app is shared by several devices on one account (the presence counter shows it), so a phone left open shows stale queues.
- Two deletes use the browser's native `window.confirm` box, which looks foreign next to the Aurora dialogs.
- It cannot be added to the iPhone home screen as an app (no manifest, no app icon, no theme colour).

The owner chose to do P1 first, then P2 (2026-11-12).

## 2. Goals

PR-A (P1):
1. A skeleton that mirrors the queue layout on first load, instead of the text line.
2. Quiet background refresh so an open app stays current, with the guards in §4.3.
3. Clear, local pending states, so the user sees exactly what is being saved.
4. Replace both `window.confirm` calls with Aurora-styled confirm dialogs.
5. A "last updated" freshness line that is always visible and says when data is old or a refresh failed.

PR-B (P2):
6. Installable to the home screen (iOS "Add to Home Screen", Android/desktop install) with proper icons, name and theme colour; opens full screen without browser chrome.
7. (Deferred by owner: no offline screen / service worker in PR-B.)

## 3. Non-goals and anti-goals

- **No optimistic updates** for booking, move, duration edit, or any delete. The server is the rule engine (slot conflicts and the 360-minute limit return 409 with suggestions, the "earliest" mode picks the date server-side, case delete needs a typed HN). Showing a booking the server then refuses is a patient-safety regression. *(This changes what Claude proposed in chat on 2026-11-12, deliberately.)*
- No user-facing "undo" after deletes. `app/lib/calendar-undo.ts` is a server-side race rollback used by `api/staff-unavailability` and `api/schedule-closures`, not a user undo. Re-creating a deleted closure would re-run the affected-bookings flow.
- No change to queue rules, API routes, Google Calendar integration, auth, or the HN-verified case delete.
- No split of `SchedulerApp.tsx` (that is P5). New pieces go in new files; the existing file only gains the wiring.
- No dark mode (P3), no command palette or motion work (P4).
- No push notifications.
- **Anti-goal:** anything that could show a patient in a slot that the server has not confirmed, or show stale data without saying it is stale.

## 4. PR-A design (P1)

### 4.1 First-load skeleton
- Show when `loading && !data`. Never show it on later refreshes (stale data stays visible, see §4.4).
- New file `app/Skeleton.tsx`, used in exactly two places: the queue list area (replacing "กำลังโหลดคิว…": day header + 3–4 booking rows) and the manual-date calendar area (a 7-column grid of grey cells). **The booking form stays live** and typeable during the first load, as today; search and alerts tabs keep their current behaviour. Use Aurora tokens (`--glass-a`, `--hairline`); add a soft shimmer that is disabled under `prefers-reduced-motion`.
- It has `aria-busy="true"` on the container and one visually hidden `role="status"` text "กำลังโหลดคิว…" so screen readers still hear it.

### 4.2 Pending states (no optimism)
- Keep the existing flags (`saving`, `moving`, `deleting`, `editSaving`, `closureSaving`, `unavailabilitySaving`, `syncing`).
- The button that started the action shows a small inline spinner + its existing busy label. The rest of the page stays interactive except the controls that already get `disabled`.
- After a save succeeds, the refresh that follows (`await loadSchedule()`) must not blank the list. The current data stays on screen until the new data arrives.
- Optional (builder's call): briefly highlight the booking row that was just created or moved once the refreshed data contains it (1.5 s tint, no motion under reduced-motion).

### 4.3 Quiet background refresh
Add `loadSchedule({ quiet: true })` (or a separate `refreshQuietly`). Quiet mode:
- Never sets `notice` (no `role="alert"` popping up on a flaky hospital network). A failed quiet refresh only updates the freshness line (§4.4).
- Does not set `loading`.

Triggers:
- `visibilitychange` → visible, and window `focus`.
- `online` event.
- An interval of 5 minutes while the tab is visible (Claude's call; can be changed).

Guards (skip the refresh if any is true):
- Less than 60 seconds since the last successful load (throttle). GET `/api/schedule` reads Google Calendar, including 730 days of moves.
- Any dialog is open (`bookingConflict`, `pendingClosure`, `pendingUnavailability`, `deleteDialog`, `editDialog`, the new confirm dialog).
- Any of `saving`, `moving`, `deleting`, `editSaving`, `closureSaving`, `unavailabilitySaving`, `syncing`, `exporting` is true.
- The booking form was edited within the last 3 minutes (track a `lastFormEditAt` timestamp, set in the form's change handlers). This keeps the date choices still while someone is actively filling the form, but an abandoned draft on a shared phone does not switch background refresh off forever (there is no "clear form" control, and `setForm(EMPTY_FORM)` only runs after a successful booking). *(Claude's call.)*
- A refresh is already in flight.

Failure handling (Claude's call):
- Network errors and 5xx stay quiet: only the freshness line changes (§4.4).
- **401 is never quiet.** Both 401 cases (signed-out session, and the dead server-held Google token `invalid_grant`, see `app/lib/calendar.ts` ~176–198) behave exactly like today's non-quiet failure: set `calendarError` (amber setup banner, pill "Calendar ยังไม่เชื่อม") and the error `notice`. No automatic redirect to `/signin` (it would throw away a half-filled form); the existing banner/notice text tells the user what to do.

When a refreshed date is no longer available (Claude's call):
- If the form's selected date (`requestedDate` / chosen slot) is no longer offered after a refresh, keep the value, show an inline note under the date field "วันที่เลือกเต็มหรือปิดแล้ว กรุณาเลือกวันใหม่", and leave the final word to the server (the existing 409 + suggestions flow). Do not silently clear it.

Search tab and selected case (Claude's call):
- The move / duration / delete APIs re-read the case server-side and validate it (`app/api/cases/[id]/move/route.ts`, `app/api/cases/[id]/route.ts`), so a stale selection cannot write wrong data. To satisfy the anti-goal on screen: after a successful refresh, if `selectedCase` is missing from `data.bookings` or its `scheduleDate`/`queueType` differs, show an inline note on the selected-case card "เคสนี้ถูกแก้จากอีกเครื่อง กรุณาค้นหาใหม่" and disable its move / edit / delete buttons until the user searches again. Search results themselves are not auto re-run.

Side effect to handle: `lastSyncedAt` is in the dependency list of the staff-schedule effect, so every refresh refetches `/api/staff-schedule`. Builder decides whether that is acceptable (probably fine with the 60 s throttle) or keys that effect on a separate counter that only the visible "Sync" and saves bump.

### 4.4 Freshness line
- Renders once the first load has succeeded and `data.calendarConnected` is true (same condition as today; before that, or when Calendar is disconnected, the existing setup banner covers it). Keeps the existing "ข้อมูลเดิม N เคส" (`importedCount`) part.
- The existing `p.last-sync` becomes a small persistent status: "อัปเดตล่าสุด 10:42" (Bangkok time), or "อัปเดตเมื่อ 12 นาทีที่แล้ว" once older than 10 minutes, shown in the amber token.
- If the last quiet refresh failed: "เชื่อมต่อไม่ได้ · ข้อมูลล่าสุดเมื่อ 10:42" + a small "ลองใหม่" text button that runs the normal (non-quiet) sync.
- Keeps `role="status"`. It does not use `aria-live="assertive"`.

### 4.5 Replace `window.confirm`
- New file `app/ConfirmDialog.tsx`, using the existing dialog markup and classes (`queue-conflict-backdrop`, `queue-conflict-dialog`), `role="alertdialog"`, `aria-modal="true"`, labelled title + message, buttons "ยกเลิก" and a danger-styled confirm ("ลบ").
- One piece of state, e.g. `confirmDialog: { title, message, confirmLabel, onConfirm } | null`. Add it to the shared modal effect (Escape, Tab trap, body scroll lock) and to its dependency list; initial focus on "ยกเลิก" (safer default for a destructive action); focus returns to the trigger button on close.
- Used by `deleteClosure` and `deleteUnavailability`. Same messages as today.
- The HN-verified case delete dialog is **not** changed.
- Update `tests/staff-unavailability-wiring.test.mjs:124`, which asserts `confirm(...ลบวันที่ staff ไม่ว่าง`, to assert the new dialog wiring instead.

### 4.6 Post-booking "กด Sync ทันที" modal → non-blocking message (owner decided 2026-11-12)
After a booking the app already calls `loadSchedule()`; today it then shows a blocking modal asking the user to press "Sync ทันที" (commit `7319cbe`). **Owner chose: replace it with a non-blocking message.**
- Remove the `showSyncPrompt` modal (state, JSX, its entry in the shared modal effect and its focus ref, `confirmSyncAfterBooking`).
- After the post-booking `loadSchedule()` succeeds, the success `notice` reads e.g. "บันทึกคิวแล้ว · ยืนยันกับ Google Calendar แล้ว • <date> • <room>". If that refresh fails, the notice says the booking was saved but could not be confirmed yet, with the freshness line's "ลองใหม่".
- Update `tests/app-rules.test.mjs:274` (asserts the modal text) to assert the new message; keep the menu's "↻ Sync ทันที" button and its tests (`tests/app-rules.test.mjs:34`, `tests/mobile-shell.test.mjs:106`).

## 5. PR-B design (P2)

### 5.1 Manifest and icons (always in PR-B)
- `app/manifest.ts` (Next 16 file convention, see `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/manifest.md`): name "OR Queue — Breast & Endocrine Surgery CMU", short_name "OR Queue", `start_url: "/?tab=schedule"`, `display: "standalone"`, `background_color: "#fbf4f6"` (`--bg-base`), `theme_color: "#a71955"` (`--rose`) or the base colour (builder picks what looks right in the iOS status bar), `lang: "th"`.
- Icons generated once from `public/unit-logo.jpg` (2048×2080, enough resolution; padded to square): 192, 512, a 512 maskable with safe-zone padding, and a 180 `apple-icon.png` (Next `apple-icon` file convention). Commit the generated PNGs and the small script that made them.
- `viewport.themeColor` in `app/layout.tsx` (Next 16 puts `themeColor` in `viewport`, not `metadata`), plus `appleWebApp: { capable: true, title: "OR Queue", statusBarStyle: "default" }` in metadata.
- Safe-area: the bottom nav and top bar already pad for `env(safe-area-inset-*)`. Verify in standalone mode.
- No custom install button (`beforeinstallprompt` doesn't work on iOS Safari). An optional one-time hint card on iPhone Safari ("แตะ แชร์ → เพิ่มไปยังหน้าจอโฮม"), dismissible and remembered in localStorage. Builder's call.

### 5.2 Service worker — not in PR-B (owner decided 2026-11-12)
- **PR-B ships manifest + icons + iOS meta only. No service worker, no offline page.** Rollback stays a normal Vercel promote.
- **Patient data is never stored on the device for offline use** (owner decided: ไม่เก็บ). Any future offline work may cache only a static offline page and its assets, never `/api/*` or the `/` HTML, and must come back through a new spec with a kill-switch rollback plan (Vercel promote does not unregister a service worker).

### 5.3 Must verify on a real iPhone (cannot be proven in a simulator)
- Google sign-in works *inside* the installed app. iOS standalone apps have their own cookie storage and OAuth can bounce to Safari. If sign-in breaks, the fallback is to tell users to keep using Safari, and PR-B must not ship until this is checked.
- Status-bar colour, safe areas, bottom nav in standalone mode.
- Tapping a link to `/privacy` / `/terms` stays in the app.

## 6. Verification
- `npm test`, `npx tsc --noEmit`, `npx eslint auth.ts app scripts tests` (repo rule). Revert `next-env.d.ts` if `next dev` rewrites it.
- New source-text tests in the repo's style (`tests/*.test.mjs`): skeleton wired to `loading && !data`; quiet refresh never calls `setNotice`; guard list present; no `window.confirm` left in `SchedulerApp.tsx`; manifest fields; no `sw.js` / `serviceWorker.register` added in PR-B.
- WebKit render (Playwright, iPhone 13 size) of the skeleton, the freshness line in 3 states and the confirm dialog, the way the menu fix was checked (see HANDOFF_2026-11-12 "ต่อ 3").
- `next build` passes locally before pushing.
- Each PR: branch → PR → Vercel preview → owner looks on iPhone → merge. Rollback for PR-A = Vercel promote `2493de6`.

## 7. Owner decisions (answered 2026-11-12 via choice buttons)
- **Q1** post-booking Sync modal → "เปลี่ยนเป็นข้อความแจ้ง" (non-blocking message, §4.6).
- **Q2** patient data on the device for offline → "ไม่เก็บ" (§5.2).
- **Q3** PR-B scope → "ติดตั้งได้ก่อน" (manifest + icons only, §5.2).

## 8. Calls Claude made (owner may override)
- Background refresh every 5 min while visible, throttle 60 s, stale warning after 10 min.
- Initial focus on "ยกเลิก" in the new confirm dialog.
- Icons from `unit-logo.jpg`; theme colour from Aurora tokens.
- Two PRs, P1 first.
- Refresh guard uses "form edited in the last 3 minutes", not "form is dirty".
- 401 on a quiet refresh shows today's banner + notice (never quiet, no auto redirect).
- A refreshed-away selected date is kept with an inline note; the server decides.
- A selected case changed by another device gets a note and its action buttons are disabled.
- Skeleton covers only the queue list and the manual-date calendar; the booking form stays live.
- Freshness line keeps "ข้อมูลเดิม N เคส" and today's render condition.
