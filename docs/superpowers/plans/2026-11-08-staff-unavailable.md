# Staff Unavailable Days Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the team record per-staff unavailable date ranges so a case cannot be booked or moved onto a day where every staff on the case is unavailable, with warnings for partial cases and live "ควรย้ายวัน" badges on existing clashing cases.

**Architecture:** One pure, import-free rules module (`app/lib/staff-unavailability.ts`) holds all decisions (overlap, who is unavailable on a date, blocked vs warning, clash). It is used by the server (`queue.ts`, routes) and the client (`SchedulerApp.tsx`). Entries are all-day Google Calendar events tagged `or_queue=staff_unavailable`, read by the existing `listCalendarData` call and surfaced as `DaySummary.unavailableStaff`, so the existing shared check `destinationError` enforces the rule for booking and move. A new `/api/staff-unavailability` route manages entries, modelled on `/api/schedule-closures`.

**Tech Stack:** Next.js 16 App Router (breaking changes: read `node_modules/next/dist/docs/` before writing a route handler, per `AGENTS.md`), TypeScript strict, Google Calendar REST via `googleFetch`, `node --test` (Node 26 strips TypeScript types natively).

**Spec:** `docs/superpowers/specs/2026-11-08-staff-unavailable-design.md` (decisions 1–18, calls B–K; call A is superseded by decision 17). Vocabulary: `GLOSSARY.md`.

## Global Constraints

- Work on branch `feat/staff-unavailable`; one commit per task; **no push, merge or deploy without the owner's explicit go** (push needs `gh auth switch -u chagkrit`, then switch back to `residentsurgcmu`).
- Calendar tag `or_queue=staff_unavailable`; private props `staff`, `note`, `created_by`, `created_at`, `updated_by`; event is all-day, `end.date` = last day + 1; `colorId` "8"; `transparency` "transparent"; summary `{staff} ไม่ว่าง` (with ` • {note}` appended when a note exists).
- One event per staff per range. Create uses POST **without** an id (Google assigns it); edit uses PATCH. Do not use `deterministicId` (an id derived from staff+start would collide after an edit moves the start).
- Dates are ISO `YYYY-MM-DD`; "today" is `dateOnly()`; allowed range is `dateOnly()` through `endOfRollingHorizon()`; note max 500 characters.
- Staff are identified by the display names in `STAFF_OPTIONS` (`app/lib/schedule.ts`).
- Thai copy, exact: badge `ควรย้ายวัน`; blocked label `ไม่ว่าง`; message `{names joined by ", "} ไม่ว่างในวันที่เลือก`; grey calendar label `ไม่ว่าง`.
- Rules: booking/move refused only when **every known staff** on the case is unavailable; allowed with a warning when only some are. Existing case "clashes" when **any** known staff on it is unavailable on its date. A case with no known staff is never blocked or flagged.
- Do not touch existing cases, do not change `STAFF_OPTIONS`, do not print or commit secrets.
- Checks before done: `npm test`, `npx tsc --noEmit`, `npx eslint auth.ts app scripts tests`. `next dev` on this Google Drive folder is very slow and rewrites `next-env.d.ts` (revert with `git checkout -- next-env.d.ts`).

## Review Focus

1. Case with an empty or unknown staff list on an unavailable day: must not be blocked or flagged. (Task 1 test.)
2. Entries touching but not overlapping (3–4 Mar and 5–6 Mar, same staff): allowed; 4–5 and 5–6 overlap. (Task 1 test.)
3. An entry that started before today or before the fetch window but still covers the date: still blocks. (Task 1 test; Task 2 fetch is by overlap.)
4. A stale page (chosen day loaded before the entry existed) books or moves onto a blocked day: server answers 409 naming the staff, and the post-write re-check undoes a write that raced with a new entry. (Task 4 tests.)
5. An entry whose staff name is no longer in `STAFF_OPTIONS` (renamed): ignored by the rule, never crashes, shown in the manager with a "ไม่พบ Staff ในรายชื่อ" label so it can be deleted. (Task 1 and Task 7 tests.)

---

## File Structure

- Create `app/lib/staff-unavailability.ts` — pure rules, no imports (client and server safe).
- Create `app/lib/affected-booking.ts` — shared view of a booking for confirmation lists (extracted from `schedule-closures/route.ts`).
- Create `app/api/staff-unavailability/route.ts` — POST (create/edit) and DELETE.
- Modify `app/lib/calendar.ts` — entry type, parsing in `listCalendarData`, save/delete functions.
- Modify `app/lib/queue.ts` — `DaySummary.unavailableStaff`, `getSchedule` result, `destinationError`, `staffBlockedOn`.
- Modify `app/api/schedule/route.ts`, `app/api/cases/[id]/move/route.ts`, `app/api/schedule-closures/route.ts` (import the shared mapper only).
- Modify `app/SchedulerApp.tsx`, `app/globals.css` — client plumbing, warnings, manager, badges.
- Create `tests/staff-unavailability.test.mjs` (behavior) and `tests/staff-unavailability-wiring.test.mjs` (source checks, same style as `tests/app-rules.test.mjs`).
- Modify `README.md` — one short section.

---

### Task 1: Pure rules module

**Files:**
- Create: `app/lib/staff-unavailability.ts`
- Test: `tests/staff-unavailability.test.mjs`

**Interfaces:**
- Produces (all exported from `app/lib/staff-unavailability.ts`, no imports):
  - `type DateRange = { startDate: string; endDate: string }` (inclusive)
  - `type UnavailableEntry = DateRange & { staff: string; id?: string }`
  - `isIsoDate(value: string): boolean` — real calendar date in `YYYY-MM-DD`
  - `rangesOverlap(a: DateRange, b: DateRange): boolean` — inclusive on both ends
  - `findOverlappingStaff(entries: readonly UnavailableEntry[], staff: readonly string[], range: DateRange, ignoreId?: string): string[]` — staff (input order, distinct) that already have an entry overlapping `range`, ignoring the entry with `ignoreId`
  - `unavailableStaffOn(entries: readonly UnavailableEntry[], date: string, knownStaff: readonly string[]): string[]` — distinct staff unavailable on `date`, in `knownStaff` order, names not in `knownStaff` dropped
  - `type CaseStaffStatus = { blocked: boolean; unavailableStaff: string[] }`
  - `caseStaffStatus(caseStaff: readonly string[], unavailableOnDate: readonly string[], knownStaff: readonly string[]): CaseStaffStatus` — considers only case staff that are in `knownStaff`; `unavailableStaff` = those of them unavailable; `blocked` = at least one considered staff and all are unavailable
  - `staffUnavailableMessage(staff: readonly string[]): string` — `{names joined by ", "} ไม่ว่างในวันที่เลือก`

- [ ] **Step 0: Create the branch** `git switch -c feat/staff-unavailable` (from `main`; leave the untracked `HANDOFF_*.md`, `AGENTS.md`, `CLAUDE.md` untracked).
- [ ] **Step 1: Write the failing tests** in `tests/staff-unavailability.test.mjs`, importing `../app/lib/staff-unavailability.ts`. Tests and assertions:
  - `isIsoDate`: `"2027-03-04"` true; `"2027-02-30"`, `"2027-3-4"`, `""` false.
  - `rangesOverlap`: 3–4 Mar vs 5–6 Mar false; 4–5 vs 5–6 true; a range fully inside another true.
  - `findOverlappingStaff`: entries `[{id:"e1",staff:"อ จักรกริช",startDate:"2027-03-03",endDate:"2027-03-05"}]`; staff `["อ จักรกริช","อ กีรติ"]`, range 5–7 Mar → `["อ จักรกริช"]`; same call with `ignoreId:"e1"` → `[]`; range 6–7 Mar → `[]`.
  - `unavailableStaffOn`: an entry that started 2027-01-01 and ends 2027-03-10 covers 2027-03-04; an entry for `"อ ชื่อเก่า"` (not in known staff) is dropped; result order follows `knownStaff`.
  - `caseStaffStatus`: single staff A unavailable → `{blocked:true, unavailableStaff:["A"]}`; staff [A,B] with only A unavailable → `{blocked:false, unavailableStaff:["A"]}`; staff `[]` and staff `["ไม่รู้จัก"]` with everything unavailable → `{blocked:false, unavailableStaff:[]}`.
  - `staffUnavailableMessage(["อ จักรกริช"])` equals `"อ จักรกริช ไม่ว่างในวันที่เลือก"`; two names joined with `", "`.

- [ ] **Step 2: Run** `node --test tests/staff-unavailability.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the module with the signatures above. ISO dates compare as strings, so no date arithmetic is needed; `isIsoDate` validates by constructing `Date.UTC` and comparing the round-trip.
- [ ] **Step 4: Run** the same command. Expected: all PASS.
- [ ] **Step 5: Commit** (also include the spec, this plan and `GLOSSARY.md`): `git add app/lib/staff-unavailability.ts tests/staff-unavailability.test.mjs docs/superpowers GLOSSARY.md && git commit -m "feat: staff unavailability rules module"`.

---

### Task 2: Calendar storage

**Files:**
- Modify: `app/lib/calendar.ts` (types near line 39; `listCalendarData` ~297-347; closure functions ~620-660 as the pattern)
- Test: `tests/staff-unavailability-wiring.test.mjs`

**Interfaces:**
- Consumes: `googleFetch`, `listAllEvents`, `addDays`, `STAFF_EVENT_COLORS` untouched, `CALENDAR_ID`, `AUTHORIZED_EMAIL` (all already in the file).
- Produces:
  - `type CalendarStaffUnavailability = { id: string; staff: string; startDate: string; endDate: string; note: string; createdBy: string; createdAt: string; updatedBy: string; updatedAt: string }` (`endDate` inclusive)
  - `listCalendarData` result gains `staffUnavailability: CalendarStaffUnavailability[]` sorted by `startDate` then `staff`; built from events with `or_queue === "staff_unavailable"`; `endDate = addDays(event.end.date, -1)`, falling back to `startDate` when `end.date` is missing
  - `saveStaffUnavailabilityEvent(request: Request, entry: { id?: string; staff: string; startDate: string; endDate: string; note: string; updatedBy: string; createdAt?: string; createdBy?: string }): Promise<string>` — with `id`: PATCH and return it; without: POST (no id in body) and return the id from the JSON response
  - `deleteStaffUnavailabilityEvent(request: Request, id: string): Promise<void>`

- [ ] **Step 1: Write failing source tests** in `tests/staff-unavailability-wiring.test.mjs` (read `app/lib/calendar.ts`): matches `or_queue: "staff_unavailable"`, `saveStaffUnavailabilityEvent`, `deleteStaffUnavailabilityEvent`, `staffUnavailability`, `addDays(entry.endDate, 1)`, `addDays(end, -1)` or equivalent for the inclusive end; and the save function body does **not** reference `deterministicId`.
- [ ] **Step 2: Run** `node --test tests/staff-unavailability-wiring.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the type, parsing and the two functions following the closure functions' shape (event body per Global Constraints; description lines: `วันที่ staff ไม่ว่าง`, `Staff: …`, `ช่วงวันที่: …`, `หมายเหตุ: …`, `แก้ไขโดย: …`). Legacy parsing already skips events with `or_queue` (`app/lib/legacy-calendar.ts:43`); add a test line asserting that file still contains `extendedProperties?.private?.or_queue`.
- [ ] **Step 4: Run** the test file. Expected: PASS. Run `npx tsc --noEmit`. Expected: no errors.
- [ ] **Step 5: Commit** `feat: store staff unavailability in Google Calendar`.

---

### Task 3: Queue integration (the shared rule)

**Files:**
- Modify: `app/lib/queue.ts`
- Test: `tests/staff-unavailability-wiring.test.mjs`

**Interfaces:**
- Consumes: Task 1 `unavailableStaffOn`, `caseStaffStatus`, `staffUnavailableMessage`; Task 2 `listCalendarData(...).staffUnavailability`; `STAFF_OPTIONS`.
- Produces:
  - `DaySummary` gains `unavailableStaff: string[]` (set on all three places that build a summary: normal OR17 days, extra days, legacy extra days), computed per date with `unavailableStaffOn(staffUnavailability, date, STAFF_OPTIONS)`
  - `getSchedule` result gains `staffUnavailability` (pass-through of the calendar array)
  - `destinationError(booking: Pick<CalendarBooking, "isCancer"> & { staffMembers?: readonly string[] }, day?: DaySummary): string` — after the `day.closed` check and before the capacity check, returns `staffUnavailableMessage(status.unavailableStaff)` when `caseStaffStatus(booking.staffMembers ?? [], day.unavailableStaff, STAFF_OPTIONS).blocked`
  - `staffBlockedOn(staffMembers: readonly string[], day: Pick<DaySummary, "unavailableStaff">): boolean`

- [ ] **Step 1: Write failing source tests**: `queue.ts` matches `unavailableStaff: string[]`, `staffUnavailability`, `caseStaffStatus`, `export function staffBlockedOn`, and the `destinationError` signature containing `staffMembers?:`; the check appears after `if (day.closed)` (assert index order on the source text).
- [ ] **Step 2: Run** the wiring test file. Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** wiring tests (PASS) and `npx tsc --noEmit` (fix any caller that now needs `unavailableStaff`; callers are limited to this file and the routes handled in Task 4).
- [ ] **Step 5: Commit** `feat: enforce staff unavailability in destinationError`.

---

### Task 4: Enforce in booking, move and post-write re-check

**Files:**
- Modify: `app/api/schedule/route.ts` (`matchesClinicalRules`, dropdown filter, `selectedDayError`, `invalidDestination`, the verify block, the GET payload), `app/api/cases/[id]/move/route.ts`
- Test: `tests/staff-unavailability-wiring.test.mjs`

**Interfaces:**
- Consumes: Task 3 `destinationError` (now staff-aware), `staffBlockedOn`, `staffUnavailableMessage` (Task 1).
- Produces: GET `/api/schedule` payload gains `staffUnavailability` (from `getSchedule`); 409 responses for blocked days carry the message from `destinationError`.

- [ ] **Step 1: Write failing source tests**: in `schedule/route.ts` every `destinationError({ isCancer }` call now passes `staffMembers` (assert no remaining `destinationError({ isCancer }, ` text), the verify block references `staffBlockedOn(staffMembers, verifiedDay)`, and the GET JSON includes `staffUnavailability`; in `move/route.ts` the verify block references `staffBlockedOn(booking.staffMembers, verifiedDay)`.
- [ ] **Step 2: Run** the wiring test file. Expected: FAIL.
- [ ] **Step 3: Implement.** In the booking route pass `{ isCancer, staffMembers }` to every `destinationError` call (candidate filter, `alternativeDays`, dropdown days, selected-day error, invalid-destination check). This also makes the `same_staff` rule skip days where every selected staff is unavailable (decision 13) with no extra code. In both verify blocks add the staff check next to `verifiedDay.closed` and return 409 with `staffUnavailableMessage(verifiedDay.unavailableStaff)` after undoing the write (delete for booking, `restoreCalendarBooking` for move). Do not catch Calendar read errors (fail closed). The move route already passes the loaded `booking` (has `staffMembers`) to `destinationError`; confirm no change is needed there beyond the verify block.
- [ ] **Step 4: Run** wiring tests, `npm test`, `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: refuse booking and move onto days where all staff are unavailable`.

---

### Task 5: Entries API

**Files:**
- Create: `app/api/staff-unavailability/route.ts`, `app/lib/affected-booking.ts`
- Modify: `app/api/schedule-closures/route.ts` (import `affectedBookingView` instead of its local `affectedBooking`)
- Test: `tests/staff-unavailability-wiring.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`isIsoDate`, `findOverlappingStaff`, `unavailableStaffOn`, `caseStaffStatus`), Task 2 save/delete + `listCalendarData`, `isStaffOption`, `orderedStaffMembers`, `dateOnly`, `endOfRollingHorizon`, `AUTHORIZED_EMAIL`, `patientDisplayName`.
- Produces:
  - `affectedBookingView(booking: CalendarBooking): { id; hn; patientName; operation; staffMembers; queueType; slotNo }` in `app/lib/affected-booking.ts` (same fields the closure route returns today)
  - `POST /api/staff-unavailability` body `{ id?: string; staff?: string[]; startDate: string; endDate: string; note?: string; confirmExistingBookings?: boolean }` → 201 `{ entries: [{ id, staff, startDate, endDate, note }], affectedBookings, message }` (create) or 200 (edit)
  - `DELETE /api/staff-unavailability?id=` → `{ message }`
  - 400 invalid input; 404 unknown id; 409 `{ error, overlappingStaff }` on overlap; 409 `{ requiresConfirmation: true, affectedBookings, message }` when existing cases clash and `confirmExistingBookings` is not true

- [ ] **Step 1: Write failing source tests**: the new route file matches `requiresConfirmation: true`, `confirmExistingBookings`, `overlappingStaff`, `findOverlappingStaff`, `isStaffOption`, `500`, exports only `POST` and `DELETE` (no other `export`); `affected-booking.ts` exists; `schedule-closures/route.ts` imports `affectedBookingView`.
- [ ] **Step 2: Run** the wiring test file. Expected: FAIL.
- [ ] **Step 3: Implement** the route modelled on `schedule-closures/route.ts`. Validation order: dates (`isIsoDate`, `startDate >= today`, `endDate <= endOfRollingHorizon(today)`, `startDate <= endDate`), note length, staff (create: non-empty array, each `isStaffOption`, no duplicates; edit with `id`: ignore `staff`, keep the stored one, 404 if the id is not found). Then load `listCalendarData(request, today, horizonEnd)` once; overlap check over all selected staff (ignore the edited entry's id) rejects the **whole** save with 409 and writes nothing. Affected cases = bookings with `scheduleDate` in the range whose staff include any selected staff (`caseStaffStatus(...).unavailableStaff.length > 0`, decision 17); if any and not confirmed, return the confirmation 409. Write one event per staff; if a write fails part-way, best-effort delete the events created in this call, then rethrow. Read the relevant Next.js route-handler guide in `node_modules/next/dist/docs/` first. Errors use `(error as { status?: number }).status || 500` as in the closure route.
- [ ] **Step 4: Run** wiring tests, `npm test`, `npx tsc --noEmit`, `npx eslint auth.ts app scripts tests`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: staff unavailability API`.

---

### Task 6: Client data plumbing, availability labels and warnings

**Files:**
- Modify: `app/SchedulerApp.tsx` (`Day` type ~line 12, `ScheduleResponse` ~51, `availabilityFor` ~371-388, `availableDays` ~672-679, dropdown options ~1338-1344, `moveDates` ~725-735 and its option render ~1524, booking submit area)
- Modify: `app/globals.css`
- Test: `tests/staff-unavailability-wiring.test.mjs`

**Interfaces:**
- Consumes: Task 1 `caseStaffStatus`, `staffUnavailableMessage` (import from `./lib/staff-unavailability`; it has no imports so it is client safe); the existing `STAFF` constant in this file.
- Produces: `Day.unavailableStaff: string[]`; `ScheduleResponse.staffUnavailability: StaffUnavailability[]` where the client type mirrors the API fields; CSS class `staff-unavailable-notice`.

- [ ] **Step 1: Write failing source tests**: `SchedulerApp.tsx` imports from `./lib/staff-unavailability`, matches `unavailableStaff: string[]`, label `"ไม่ว่าง"`, class `staff-unavailable-notice`, and `moveDates` uses `caseStaffStatus`; `globals.css` matches `.staff-unavailable-notice`.
- [ ] **Step 2: Run** the wiring test file. Expected: FAIL.
- [ ] **Step 3: Implement**:
  - `availabilityFor` (manual calendar): after the closed check and before the full/Cancer/same_staff checks, if `caseStaffStatus(form.staffMembers, day.unavailableStaff, STAFF).blocked` return `{ available: false, label: "ไม่ว่าง", detail: staffUnavailableMessage(...), day }`; when only some staff are unavailable keep `available: true` and append ` · {names} ไม่ว่าง` to the detail.
  - Dropdown: days blocked by staff stay out of `availableDays` (so `manualDateStart` and the same_staff filter behave as before) but are rendered as **disabled options** labelled `{date} · ไม่ว่าง: {names}` merged into date order, in both the cancer and normal dropdowns; days with partial unavailability stay selectable with ` (อ X ไม่ว่าง)` appended.
  - `moveDates`: exclude days where `caseStaffStatus(selectedCase.staffMembers, day.unavailableStaff, STAFF).blocked`; append the same partial suffix to the option text (decision 18: same rule as booking).
  - A `role="status"` block with class `staff-unavailable-notice` above the booking submit button and under the move select lists the unavailable staff for the currently selected date when it is partial.
- [ ] **Step 4: Run** wiring tests, `npm test`, `npx tsc --noEmit`, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat: show staff unavailability in date pickers`.

---

### Task 7: Management section in the closures tab

**Files:**
- Modify: `app/SchedulerApp.tsx` (closures view state ~475-478 and handlers ~957-1016, the closures view markup, and the confirmation dialog ~1222-1245 as the model), `app/globals.css`
- Test: `tests/staff-unavailability-wiring.test.mjs`

**Interfaces:**
- Consumes: Task 5 API; the `load`/refresh function that `saveClosure` calls after success; `STAFF`.
- Produces: section titled `วันที่ staff ไม่ว่าง` below the closure manager in the same tab, with: a form (staff checkboxes allowing several, start date, end date, optional note), a list of entries (staff, date range, note, edit and delete buttons, orphan label `ไม่พบ Staff ในรายชื่อ` when the staff name is not in `STAFF`), and a confirmation dialog listing affected cases (reuse the closure confirm dialog classes) with the button text `ยืนยันและคงคิวเดิม {n} เคส`. Overlap errors show the server message naming the staff. Edit mode locks the staff selection (call C).

- [ ] **Step 1: Write failing source tests**: matches `/api/staff-unavailability`, `วันที่ staff ไม่ว่าง`, `ไม่พบ Staff ในรายชื่อ`, `confirmExistingBookings`, a delete `confirm(` prompt containing `ลบวันที่ staff ไม่ว่าง`; `globals.css` matches `.unavailability-manager`.
- [ ] **Step 2: Run** the wiring test file. Expected: FAIL.
- [ ] **Step 3: Implement** following `saveClosure`, `submitClosure`, `editClosure`, `deleteClosure` and `pendingClosure`. Date inputs are limited to `data.horizonStart`..`data.horizonEnd`. Style with the tokens in `design-system/operative-schedule/MASTER.md`; controls need visible labels, 44px touch targets and keyboard focus (dialog focus handling mirrors the closure dialog).
- [ ] **Step 4: Run** wiring tests, `npm test`, `npx tsc --noEmit`, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat: staff unavailability manager`.

---

### Task 8: Live "ควรย้ายวัน" badges

**Files:**
- Modify: `app/SchedulerApp.tsx` (`MonthlyCalendar` ~211-290, schedule list rows ~1444, search results ~1512-1516), `app/globals.css`
- Test: `tests/staff-unavailability-wiring.test.mjs`

**Interfaces:**
- Consumes: Task 1 `unavailableStaffOn`, `caseStaffStatus`; `data.staffUnavailability`; `STAFF`.
- Produces: helper in `SchedulerApp.tsx` `clashStaffFor(booking: { scheduleDate: string; staffMembers: string[] }, entries: StaffUnavailability[]): string[]` returning `caseStaffStatus(...).unavailableStaff` (non-empty means clash, decision 17); badge text `{names} ไม่ว่าง ควรย้ายวัน`; CSS classes `clash-badge` and `month-day.has-clash`.

- [ ] **Step 1: Write failing source tests**: matches `clashStaffFor`, `ควรย้ายวัน`, `has-clash`; `globals.css` matches `.clash-badge`.
- [ ] **Step 2: Run** the wiring test file. Expected: FAIL.
- [ ] **Step 3: Implement.** Compute the badge on render from `data.staffUnavailability` and the case's current `scheduleDate`; store nothing on the case. Show the badge on schedule list rows and on search results. In `MonthlyCalendar`, mark a day cell `has-clash` when any case that day clashes, and in the selected-day summary list the unavailable staff of that day and the clashing cases. Pass `staffUnavailability` down as a prop next to `closures`. Badges need text, not colour alone.
- [ ] **Step 4: Run** wiring tests, `npm test`, `npx tsc --noEmit`, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat: flag cases that clash with staff unavailability`.

---

### Task 9: Docs and full verification

**Files:**
- Modify: `README.md` (short section "วันที่ staff ไม่ว่าง": what it does, where to manage it, the rename caveat from decision 16)
- Modify: `HANDOFF_2026-11-08.md` (new dated section: built, branch name, test counts, what the owner must check on the live page)

- [ ] **Step 1: Run the full checks**: `npm test`, `npx tsc --noEmit`, `npx eslint auth.ts app scripts tests`. Expected: all pass, no new warnings.
- [ ] **Step 2: Walk the acceptance scenarios 1–11 from the spec** against the code paths (tests where they exist; for UI behaviour describe what was checked). `next dev` here is very slow: if not run, say so in the handoff instead of claiming a live check.
- [ ] **Step 3: Update README and handoff**, then `git checkout -- next-env.d.ts` if it changed, and commit `docs: staff unavailable days`.
- [ ] **Step 4: Stop.** Report to the owner; push, merge and deploy only on their go.
