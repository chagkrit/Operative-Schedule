# Case Duration and 360-Minute Daily Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every case carries an operating time in minutes; each room-day (OR 17 or OR Extra, counted separately) refuses any book / move / duration-edit that would push its total over 360 minutes, with a popup explaining why.

**Architecture:** One pure rule module (`app/lib/minutes.ts`, no Calendar imports, unit-tested) decides input validity and refusals. Calendar storage gains `duration_minutes`. The three server paths (book, move, edit) call the rule before writing and again in the existing post-write re-check (undo on failure). The client adds the input, remaining-minutes labels, a duration field in the move form for old cases, an edit-duration dialog, and reuses the existing `queue-conflict` dialog as the popup.

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before touching routing APIs — see AGENTS.md), React 19, TypeScript, Google Calendar REST, `node --test` with `tests/ts-resolve.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-09-case-duration-360-design.md` (owner decisions 1–10, Claude calls A–M). Read it first.

## Global Constraints

- Limit constant `DAILY_MINUTES_LIMIT = 360`, same for OR 17 and OR Extra, per room per day.
- Duration: whole number 1–360, required on new bookings. Messages verbatim: empty → `กรุณากรอกระยะเวลาผ่าตัดเป็นนาที`; invalid → `ระยะเวลาผ่าตัดต้องเป็นจำนวนเต็ม 1–360 นาที`.
- Storage: private extended property `duration_minutes` (string integer; absent/empty = no duration) and description line `ระยะเวลาผ่าตัด: N นาที`. Event clock time unchanged (`bookingEventTiming`).
- Existing rules (4-case cap, Cancer rules, closures, staff unavailability) unchanged and still run.
- Refusal 409 body: `{ error, reason: "minutes_exceeded", minutes: { booked, remaining, requested, over, limit: 360 } }`.
- Work on branch `feat/case-duration-360`. Never push / merge / deploy without the owner's explicit go. Do not commit HANDOFF_*.md, CLAUDE.md, AGENTS.md (untracked by design).
- Before done: `npm test`, `npx tsc --noEmit`, `npx eslint auth.ts app scripts tests` all clean. If `next dev` rewrites `next-env.d.ts`, revert it.

## Review Focus

1. Odd typed durations (`"90 นาที"`, `"90.5"`, `" 90 "`, `"0"`, `"361"`, `""`) → `" 90 "` accepted as 90, the rest rejected with the Thai messages, on both client and server. (Task 1 tests, Task 4 wiring test.)
2. Exactly 360 total is allowed; 361 is refused. (Task 1.)
3. A room-day containing any case without duration never refuses and shows no minutes label, even if its known total exceeds 360. (Task 1, Task 2.)
4. On an enforced day already over 360 (became enforced via call M), shortening a case or moving one out succeeds; lengthening is refused. (Task 1.)
5. A stale browser page that shows room for the case still gets the popup, because the server checks before write and in the post-write re-check, for move and edit as well as book. (Task 4, Task 5 wiring tests.)

---

### Task 1: Pure minutes rule module

**Files:**
- Create: `app/lib/minutes.ts`
- Test: `tests/minutes.test.mjs`

**Interfaces:**
- Produces:
  - `export const DAILY_MINUTES_LIMIT = 360;`
  - `export type MinutesRefusal = { booked: number; remaining: number; requested: number; over: number; limit: number };`
  - `export function durationInputError(value: unknown): string` — `""` when valid, else one of the two Global Constraints messages. Accepts number or string; trims strings; must match `/^\d+$/` and be 1–360.
  - `export function parseDurationMinutes(value: unknown): number | null` — the integer when `durationInputError` is `""`, else `null`.
  - `export function roomDayMinutes(durations: readonly (number | null)[]): { enforced: boolean; bookedMinutes: number }` — `enforced` = every entry non-null (an empty day is enforced); `bookedMinutes` = sum of non-null.
  - `export function minutesRefusal(others: readonly (number | null)[], previous: number | null | undefined, next: number): MinutesRefusal | null` — `others` = durations of the other cases on the target room-day (excluding the changed case); `previous` = the changed case's duration on this same room-day before the change (`undefined` when the case is new to the day: booking or move-in; `null` when it had none).
  - `export function minutesRefusalMessage(r: MinutesRefusal, roomLabel: string, dateLabel: string): string`

- [ ] **Step 1: Write the failing tests** in `tests/minutes.test.mjs` (same harness as `tests/destination.test.mjs`: `import "./ts-resolve.mjs"` then dynamic import of `../app/lib/minutes.ts`):
  - `durationInputError`: `""`, `undefined` → `กรุณากรอกระยะเวลาผ่าตัดเป็นนาที`; `"0"`, `"361"`, `"90.5"`, `"90 นาที"`, `-5`, `1.5` → `ระยะเวลาผ่าตัดต้องเป็นจำนวนเต็ม 1–360 นาที`; `"1"`, `" 90 "`, `360`, `"360"` → `""`.
  - `parseDurationMinutes(" 90 ") === 90`; `parseDurationMinutes("361") === null`.
  - `roomDayMinutes([])` → `{ enforced: true, bookedMinutes: 0 }`; `roomDayMinutes([120, null, 300])` → `{ enforced: false, bookedMinutes: 420 }`.
  - New case, boundary: `minutesRefusal([120, 120], undefined, 120) === null`; `minutesRefusal([120, 120], undefined, 121)` deep-equals `{ booked: 240, remaining: 120, requested: 121, over: 1, limit: 360 }`.
  - Owner decision 5 example: `minutesRefusal([100, 100, 100], undefined, 90)` → `{ booked: 300, remaining: 60, requested: 90, over: 30, limit: 360 }`.
  - Old day (call A): `minutesRefusal([300, null], undefined, 200) === null`.
  - Call M: `minutesRefusal([300, 100], 50, 40) === null` (shorten on over day); `minutesRefusal([300, 100], 50, 60)` non-null with `booked: 400, remaining: 0, requested: 60, over: 100`; `minutesRefusal([300, 300], null, 200) === null` (first duration on old case).
  - `minutesRefusalMessage({ booked: 300, remaining: 60, requested: 90, over: 30, limit: 360 }, "OR 17", "พฤ. 12 พ.ย. 2569")` === `"OR 17 พฤ. 12 พ.ย. 2569 ลงไว้แล้ว 300 นาที เหลือ 60 นาที เคสนี้ 90 นาที เกิน 30 นาที (เวลาผ่าตัดรวมต่อห้องต่อวันไม่เกิน 360 นาที)"`.

- [ ] **Step 2: Run** `node --test tests/minutes.test.mjs` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `app/lib/minutes.ts`.** `minutesRefusal` algorithm (call M):

```ts
if (previous === null) return null;               // setting a first duration is always allowed
if (others.some((d) => d === null)) return null;  // day not enforced after the change (call A)
const booked = others.reduce((s, d) => s + (d ?? 0), 0);
const after = booked + next;
const before = booked + (previous ?? 0);
if (after <= DAILY_MINUTES_LIMIT || after <= before) return null;
return { booked, remaining: Math.max(0, DAILY_MINUTES_LIMIT - booked), requested: next, over: after - DAILY_MINUTES_LIMIT, limit: DAILY_MINUTES_LIMIT };
```

- [ ] **Step 4: Run** `node --test tests/minutes.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit** (create the branch first): `git checkout -b feat/case-duration-360`, then `git add app/lib/minutes.ts tests/minutes.test.mjs docs/superpowers/specs/2026-11-09-case-duration-360-design.md docs/superpowers/plans/2026-11-09-case-duration-360.md && git commit -m "feat: pure 360-minute room-day rule"`.

### Task 2: Calendar storage and schedule summary

**Files:**
- Modify: `app/lib/calendar.ts` (`CalendarBooking`, `bookingFromEvent`, `createBookingEvent`, `eventDescription`, `moveCalendarBooking`, `restoreCalendarBooking`; new `updateBookingDuration`)
- Modify: `app/lib/legacy-calendar.ts` (set `durationMinutes: null`)
- Modify: `app/lib/queue.ts` (`DaySummary`, `getSchedule`; new `roomDayDurations`)
- Test: `tests/case-duration-wiring.test.mjs` (source-regex style of `tests/staff-unavailability-wiring.test.mjs`)

**Interfaces:**
- Consumes: Task 1 `roomDayMinutes`, `parseDurationMinutes`.
- Produces:
  - `CalendarBooking.durationMinutes: number | null` (parsed from `duration_minutes` via `parseDurationMinutes`; legacy → `null`).
  - `createBookingEvent(request, booking)` — `booking` now includes `durationMinutes: number` and writes `duration_minutes`.
  - `moveCalendarBooking(request, id, target: { date; queueType; slotNo; durationMinutes?: number })` — when `durationMinutes` is given it is written; otherwise the case keeps its value. Returns `{ before, after }` as today.
  - `restoreCalendarBooking(request, id, booking)` — also writes `duration_minutes: booking.durationMinutes === null ? "" : String(booking.durationMinutes)`.
  - `export async function updateBookingDuration(request: Request, id: string, durationMinutes: number): Promise<{ before: CalendarBooking; after: CalendarBooking }>` — PATCHes description + private data (sets `or_queue: "booking"` like move, so an untagged legacy event becomes a tagged booking); slot/date unchanged.
  - `eventDescription` and `createBookingEvent` description include `ระยะเวลาผ่าตัด: N นาที` (`ระยะเวลาผ่าตัด: -` when null).
  - `DaySummary` gains `bookedMinutes: number; minutesEnforced: boolean` (from `roomDayMinutes` over that room-day's bookings).
  - `export function roomDayDurations(bookings: Pick<CalendarBooking, "id" | "scheduleDate" | "queueType" | "durationMinutes">[], date: string, queueType: QueueType, excludeId?: string): (number | null)[]` in `app/lib/queue.ts`.

- [ ] **Step 1: Write failing wiring tests:** calendar.ts matches `/duration_minutes/` in `createBookingEvent`, `moveCalendarBooking`, `restoreCalendarBooking`, `updateBookingDuration` bodies (use the `functionBody` helper pattern); matches `/ระยะเวลาผ่าตัด: /`; `export async function updateBookingDuration`; queue.ts matches `/bookedMinutes/`, `/minutesEnforced/`, `/export function roomDayDurations/`; legacy-calendar.ts matches `/durationMinutes: null/`.
- [ ] **Step 2: Run** `node --test tests/case-duration-wiring.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement** the Produces list. Extract the private-data object shared by `moveCalendarBooking` and `updateBookingDuration` into one non-exported helper `bookingPrivateData(booking: CalendarBooking, previousPrivate: Record<string,string>)` rather than duplicating it.
- [ ] **Step 4: Run** `npm test` — Expected: PASS. (`npx tsc --noEmit` is expected to fail only at the `createBookingEvent` call in `app/api/schedule/route.ts`, missing `durationMinutes`; Task 3 fixes it. Any other tsc error must be fixed here.)
- [ ] **Step 5: Commit** `feat: store case duration in Calendar and summarise room-day minutes`.

### Task 3: Booking route (`POST /api/schedule`)

**Files:**
- Modify: `app/api/schedule/route.ts`
- Test: `tests/case-duration-wiring.test.mjs` (add)

**Interfaces:**
- Consumes: Task 1 `durationInputError`, `parseDurationMinutes`, `minutesRefusal`, `minutesRefusalMessage`; Task 2 `roomDayDurations`, `createBookingEvent` with `durationMinutes`.
- Produces: request body field `durationMinutes` (string or number); 400 with the input message when invalid; 409 refusal body (Global Constraints) when the chosen/specific day would exceed.

- [ ] **Step 1: Write failing wiring tests:** route source matches `/durationInputError\(/`, `/minutesRefusal\(/` at least twice (pre-write candidate filter and post-write re-check), `/reason: "minutes_exceeded"/`, and the re-check branch calls `deleteBookingEvent` when `minutesRefusal` is non-null.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement:**
  - Validate `durationMinutes` with the other required fields (400).
  - Extend `matchesClinicalRules` (and the dropdown filter and `alternativeDays`) with `!minutesRefusal(roomDayDurations(bookings, day.date, day.queueType), undefined, durationMinutes)`, so "คิวเร็วที่สุด" and suggestions skip days that don't fit (call E).
  - When no candidate and the specific selected day fails only on minutes (other `destinationError` empty), return 409 with `reason: "minutes_exceeded"`, `minutes`, `suggestions`, and `error = minutesRefusalMessage(r, roomLabel, date)` (server uses ISO date as `dateLabel`).
  - Post-write: after the existing staff/count re-checks, compute `minutesRefusal(roomDayDurations(verified.bookings, date, queueType, id), undefined, durationMinutes)`; if non-null, `deleteBookingEvent(request, id)` and return the 409 refusal body.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: enforce 360-minute room-day limit on booking`.

### Task 4: Move route and duration-edit route

**Files:**
- Modify: `app/api/cases/[id]/move/route.ts`
- Modify: `app/api/cases/[id]/route.ts` (add `PATCH`)
- Modify: `app/api/cases/search/route.ts` (include `durationMinutes` in each result)
- Test: `tests/case-duration-wiring.test.mjs` (add)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `PATCH /api/cases/[id]/move` body `{ date, queueType, durationMinutes? }`. If the case has `durationMinutes === null`, `durationMinutes` is required (400 with input message, decision 9). Destination check: `minutesRefusal(roomDayDurations(bookings, date, queueType, id), undefined, effective)` where `effective = booking.durationMinutes ?? parsed`. Write via `moveCalendarBooking(..., { ..., durationMinutes: parsed })` only when the case had none. Post-write re-check uses the same call on re-read bookings; on refusal `restoreCalendarBooking(request, id, move.before)` (restores old date AND empty duration) and 409 refusal body.
  - `PATCH /api/cases/[id]` body `{ durationMinutes }`: 400 on invalid input; 400 `ลบได้เฉพาะ…`-style past check with message `แก้ได้เฉพาะคิวของวันนี้และอนาคต`; 400 `ระยะเวลาเท่าเดิม` if unchanged; check `minutesRefusal(roomDayDurations(bookings, booking.scheduleDate, booking.queueType, id), booking.durationMinutes, next)`; write `updateBookingDuration`; post-write re-check with the same call; on refusal `restoreCalendarBooking(request, id, before)` and 409. Success `{ message: "แก้ระยะเวลาผ่าตัดและอัปเดต Google Calendar แล้ว", durationMinutes }`.
  - Search results include `durationMinutes: number | null`.

- [ ] **Step 1: Write failing wiring tests:** move route matches `/durationMinutes/`, `/minutesRefusal\(/` ≥2, `/reason: "minutes_exceeded"/`; `app/api/cases/[id]/route.ts` has `export async function PATCH`, `/updateBookingDuration\(/`, `/minutesRefusal\(/` ≥2, `/restoreCalendarBooking\(/`; search route matches `/durationMinutes/`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the Produces list. Keep the existing `statusFor` error handling in `[id]/route.ts`.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: 360-minute check on move and new duration edit endpoint`.

### Task 5: Client UI (form, labels, move field, edit dialog, popup)

**Files:**
- Modify: `app/SchedulerApp.tsx`, `app/globals.css` (only if new classes are needed)
- Test: `tests/case-duration-wiring.test.mjs` (add)

**Interfaces:**
- Consumes: Task 1 (`durationInputError`, `parseDurationMinutes`, `minutesRefusal`, `minutesRefusalMessage`, `DAILY_MINUTES_LIMIT`), Task 2 `DaySummary` fields, Task 4 endpoints and `SearchResult.durationMinutes`.
- Produces: no exports.

- [ ] **Step 1: Write failing wiring tests** (source regex on `SchedulerApp.tsx`): `EMPTY_FORM` has `durationMinutes: ""`; an input with `inputMode="numeric"` bound to `form.durationMinutes` labelled `ระยะเวลาผ่าตัด (นาที)`; text `เหลือ` + `นาที` rendered from `minutesEnforced`; `fetch(\`/api/cases/${...}\`` with `method: "PATCH"` and `durationMinutes`; `reason === "minutes_exceeded"` handled in `submitBooking`, `moveCase` and the edit handler by calling `setBookingConflict`; `BookingConflict` has `heading?: string`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement:**
  - Booking form: required field `ระยะเวลาผ่าตัด (นาที)` (`inputMode="numeric"`), added to the client `missing`/validation using `durationInputError`; sent as `durationMinutes`.
  - `nextCancerDay` (≈ line 777) and the date drop-down skip/label days using `minutesRefusal` with the typed duration once it is valid; each enforced day option shows `เหลือ X นาที` (X = `360 - bookedMinutes`, min 0). Do not grey days for minutes (call F).
  - Schedule day cards: enforced days show `ใช้ไป Y/360 นาที`; non-enforced show nothing about minutes. Case cards/search results show `N นาที` when present.
  - Move form: when `selectedCase.durationMinutes === null`, show required `ระยะเวลาผ่าตัด (นาที)` field and send it.
  - Edit: button `แก้ระยะเวลา` beside the existing move/delete actions on search results (today/future cases only); small dialog prefilled with the current value (empty for old cases), Save → `PATCH /api/cases/[id]`. Reuse the existing dialog focus-trap effect (≈ lines 619–664) by adding the new dialog state to its dependency/guard list.
  - Popup: on any 409 with `reason === "minutes_exceeded"`, `setBookingConflict({ heading, message: minutesRefusalMessage(minutes, roomLabel, displayDate(date, true)), suggestions })`; headings `ลงคิวไม่ได้: เวลาผ่าตัดรวมเกิน 360 นาที` / `สลับวันไม่ได้: เวลาผ่าตัดรวมเกิน 360 นาที` / `แก้ระยะเวลาไม่ได้: เวลาผ่าตัดรวมเกิน 360 นาที`; the dialog renders `heading` in place of `ไม่สามารถลงคิวที่เลือกได้` when present. Move/edit pass `suggestions: []`.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit && npx eslint auth.ts app scripts tests` — Expected: all clean.
- [ ] **Step 5: Commit** `feat: duration input, remaining minutes, edit dialog and 360 popup`.

### Task 6: Export column, docs, final verification

**Files:**
- Modify: `app/api/wait-time-export/route.ts` (header `ระยะเวลาผ่าตัด (นาที)` after `Operation`; empty cell when null)
- Modify: `README.md` (กติกาหลัก: one bullet on the 360-minute rule, per-room, old days exempt, edit duration)
- Modify: `GLOSSARY.md` (term **ระยะเวลาผ่าตัด** and **วัน-ห้องที่บังคับกฎ 360 นาที**)
- Test: `tests/case-duration-wiring.test.mjs` (export header regex)

- [ ] **Step 1: Write failing test** for the export header string.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** export column + docs.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit && npx eslint auth.ts app scripts tests && npm run build` — Expected: all exit 0. Revert `next-env.d.ts` if changed.
- [ ] **Step 5: Commit** `feat: export duration column; document 360-minute rule`. Do not push.
