# Bottom Navigation Bar + UI/UX Pass — Design Spec

Date: 2026-10-08
Status: Approved 2026-10-08; implemented on branch `feat/bottom-nav`
App: Operative Schedule (Next.js `^16.2.6`, React 19, `app/SchedulerApp.tsx` single client component)

## 1. Goal

Make OR Queue comfortable to use on phones and tablets by:

1. Adding a fixed bottom navigation bar with four equal-importance destinations, showing one screen at a time at widths ≤ 1000px.
2. Auditing the current UI/UX, fixing the targeted problems found, and recording the design tokens as a design system.

Desktop (> 1000px) layout and behaviour are unchanged.

## 2. Decisions already made with the user

| Topic | Decision |
|---|---|
| Scope of bottom bar | Phones and tablets, `max-width: 1000px`. Desktop keeps the two-column layout. |
| Badge | Count of schedule moves not yet seen on this device (`localStorage`), no backend change. |
| Structure | Option A: single page, links of the form `?tab=<id>`; `SchedulerApp` stays one component and hides inactive sections with CSS at ≤ 1000px. |
| After a successful booking on mobile | Switch automatically to the **ตาราง** tab. |
| Sync / Export / Sign out on mobile | Move into one menu button in a smaller top bar. |
| Work order | Review → design-system doc → bottom bar → targeted fixes. |

## 3. Destinations

| Tab id | Label | Icon | Section shown | Existing element |
|---|---|---|---|---|
| `schedule` (default) | ตาราง | calendar | 02 schedule (list / month / closures sub-tabs, OR Extra, export panel) | `.schedule-panel` |
| `book` | ลงคิว | plus | 01 patient and surgery form | `.booking-panel` |
| `search` | ค้นหา | magnifier | 03 search / move / delete case | `.case-search-panel` |
| `alerts` | แจ้งเตือน | bell | 04 recent schedule moves | `.move-history-panel` |

Closures stay as a sub-tab inside ตาราง; they are not a fifth destination.

## 4. Behaviour (≤ 1000px)

### 4.1 Routing

- Active tab is read from the `tab` query parameter. Missing or unknown values resolve to `schedule`.
- The pure function `parseTab(value: string | null | undefined): TabId` lives in `app/lib/` and is unit tested.
- Links are real anchors (`<a href="?tab=book">` (relative query), so middle-click / copy-link work). A plain left click is intercepted and calls `window.history.replaceState` (then scrolls to top); `useSearchParams` re-renders from it (Next.js 16.3 docs, *single-page-applications* guide). Switching tabs therefore adds no history entries, so Back does not walk through every tab visited.
- **Revised 2026-10-08 (plan stage):** `next/link` is not used. The page is dynamic (it calls `auth()`), so a `<Link>` to `/?tab=…` would make a server round trip on every tab press; `replaceState` stays entirely client-side.
- Switching tabs has no transition or animation.
- Docs checked while planning: `useSearchParams`, `generateViewport` (`viewport` export), and the native History API integration, all under `node_modules/next/dist/docs/` (per `AGENTS.md`).

### 4.2 Visibility

- `<main className="app-shell" data-screen="…">` carries the active tab id.
- CSS under `@media (max-width: 1000px)` applies `display: none` to the three inactive sections, so they are neither focusable nor read by screen readers. Above 1000px no rule applies and all sections show.
- The large hero shows only on the ตาราง tab on mobile.
- Global status UI (setup banner, last-sync line, notice, modal dialogs) is independent of the active tab and keeps its current placement. Dialogs must stack above the bar.

### 4.3 Booking success

On a successful save at ≤ 1000px, navigate (replace) to `?tab=schedule` and keep the existing success notice visible. Failure and conflict dialogs keep the user on `book`.

### 4.4 Top bar and menu (≤ 1000px)

- Top bar is reduced to logo, title and one "เมนู" button.
- The menu is a disclosure (`aria-expanded`, `aria-controls`) containing: calendar connection status, "Sync ทันที", "Export Excel", "ออกจากระบบ". Escape and outside click close it; focus returns to the button.
- Above 1000px the existing top bar actions are unchanged. The sign-out remains a `<form action={signOutAction}>`.

## 5. Bottom bar component

- Markup: `<nav aria-label="เมนูหลัก">` containing four `<a>`; the active link has `aria-current="page"`.
- Each link: inline SVG icon (24px, stroke style, `aria-hidden`) above a text label. No emoji.
- Label font ≥ 12px; touch target ≥ 44px tall and equal width (`grid-template-columns: repeat(4, 1fr)`).
- Selected: colour `--rose`; others: `--muted`. Existing tokens and the soft surface style are reused; no new colours. Verify contrast ≥ 4.5:1 for label text on the bar surface and adjust `--muted` usage there if it fails.
- `position: fixed; bottom: 0; left: 0; right: 0`, with `padding-bottom: env(safe-area-inset-bottom)`.
- `app/layout.tsx` exports `viewport = { viewportFit: "cover" }`; without it `env(safe-area-inset-bottom)` is 0 on iOS.
- `.app-shell` bottom padding = bar height + `env(safe-area-inset-bottom)` so the footer and last content are not covered.
- Visible focus ring on links (do not remove outlines). Respect `prefers-reduced-transparency` like the existing glass elements.
- Hidden entirely above 1000px.

## 6. Badge on แจ้งเตือน

- `unseen = recentMoves.filter(m => Date.parse(m.movedAt) > lastSeenAt).length`; pure function `countUnseen(moves, lastSeenAt)` in `app/lib/`, unit tested.
- `lastSeenAt` is stored in `localStorage` (key `or-queue:alerts-seen`) as epoch ms.
  - First visit with no stored value: set to now, so the badge starts at 0.
  - Updated to now whenever the `alerts` tab is active and move data has loaded.
- A move the user makes on this device is marked seen immediately after the schedule reloads (otherwise their own action would show as an unseen alert).
- Display: nothing when 0; the number up to 9; `9+` beyond.
- Link `aria-label`: `แจ้งเตือน ยังไม่ได้ดู N รายการ` when N > 0.
- All `localStorage` access is wrapped in try/catch; if unavailable, the badge is simply not shown and the app works normally.
- Per-device counting is intentional: different devices may show different numbers.

## 7. UI/UX review (item 1)

Read-only audit before any CSS change, against the ui-ux-pro-max checklist (accessibility, touch targets, contrast, responsive, typography) using code inspection plus screenshots at 390×844 and 1280×800. Output: a prioritised findings list (`docs/superpowers/specs/2026-10-08-ui-review-findings.md`). The list sets the final scope of section 9. Candidate issues already visible in the code: body text at 8–10px in several mobile rules, 30–35px controls, `--muted` on the soft background, tab labels at 8px at ≤ 480px.

## 8. Design system document (item 3)

Create `design-system/operative-schedule/MASTER.md` that records the **existing** tokens (`--ink`, `--muted`, `--rose`, `--rose-deep`, `--green`, `--danger`, soft-UI `--raised` / `--pressed` shadows, radii, type stack) plus the new bar tokens (bar height, icon size, badge size). It documents; it does not introduce a new palette or restyle the app. If the search tool suggests a different palette, that is noted as a non-adopted alternative only.

## 9. Targeted fixes (item 2)

Applied after the bottom bar, limited to what the review confirms, expected to include:

- raise sub-12px body text and tab labels to ≥ 12px on mobile,
- raise primary mobile controls to ≥ 44px,
- fix any text/background pair below 4.5:1,
- ensure visible keyboard focus on new and existing controls touched.

Anything larger than this list is reported back rather than done.

## 10. Testing and verification

- Unit tests (`tests/`, `node --test`): `parseTab` (valid, missing, unknown, array-like), `countUnseen` (none, some, equal timestamp, invalid date).
- `npm run lint`, `npm run build`, `npm test` must pass.
- Browser check at 390px and 1280px: tab switching, `aria-current`, deep link `/?tab=search`, inactive sections not focusable, desktop unchanged, dialogs above the bar, booking success switches to ตาราง without stealing focus from the sync dialog, menu open/close with keyboard.
- The real page needs Google sign-in and live Calendar data, which are not available in development (no `.env.local`). Verification therefore uses a **temporary, uncommitted preview route** (`app/preview`) that renders `SchedulerApp` with a mocked `fetch`; it is deleted before any commit or deploy.
- Limitation: iPhone safe-area rendering cannot be reproduced in desktop Chromium. Desktop verification covers that `viewport-fit=cover` and the `env()` padding rules are present. Because the preview route needs no login, the user can open it on an iPhone over the local network (optional, temporary `allowedDevOrigins` setting) to check real home-indicator clearance.

## 11. Out of scope

- Splitting `SchedulerApp.tsx` into multiple files or real routes.
- Any backend or Google Calendar change, server-side read state for alerts.
- A fifth tab, redesign of the colour palette, desktop layout changes.

## 12. Risks

| Risk | Mitigation |
|---|---|
| `useSearchParams` needs a Suspense boundary or has changed behaviour in this Next.js version | Read the bundled docs first; verify with `npm run build`. |
| Hidden sections lose scroll or focus context when switching | Scroll to top on switch; move focus to the screen heading. |
| Fixed bar covers content or dialogs | Bottom padding on shell; explicit z-index ordering; browser check. |
| Badge shows different counts on different devices | Accepted by decision in section 2. |
| Booking-success auto-switch hides the form while the user expects to enter another case | Notice stays visible; user can return via the bar. Revisit after use if it annoys. |
