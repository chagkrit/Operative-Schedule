# Staff unavailable days (วันที่ staff ไม่ว่าง) — design

Status: DRAFT for owner approval, 2026-11-08. Nothing is built. Vocabulary: see `GLOSSARY.md`.

## Intent and why

The unit books surgery cases into OR queues (Tuesday/Thursday "OR 17" days, plus OR Extra days). Each case names one or more staff surgeons. Today the app can only close a whole day for everyone (วันปิดรับคิว). When one staff is away (meeting, leave) the app still offers that day for that staff's cases, so people book cases the surgeon cannot operate.

Example that triggered this: อ จักรกริช is unavailable on 4 March 2570 (= 2027-03-04, a Thursday, normal OR 17 day). That day must not be selectable for a case whose only staff is อ จักรกริช, while the day stays fully open for other staff's cases.

## Goals

- Record per-staff unavailable date ranges (full days).
- Block booking and moving a case onto a day when every staff on the case is unavailable that day.
- Show why (grey, unselectable, with reason) instead of silently hiding.
- Warn, but allow, when only some of a case's staff are unavailable.
- Never touch existing bookings automatically; make the conflict visible until a human resolves it.

## Non-goals

- Half-day or time-of-day unavailability.
- Automatically moving, deleting or reassigning existing cases.
- Editing a case's staff after booking (not possible today; stays that way).
- Staff ids / renaming support (staff are identified by display name today).
- Per-user permissions (the app is one shared login, hnbcmu).
- Notifications.

## Anti-goals (failure even if it "works")

- An unavailable staff must never close the day for other staff's cases.
- No silent deletion or silent move of an existing case.
- A stale open browser page must not be able to book onto an unavailable day (rule is enforced on the server, not only in the UI).

## Decisions made by the owner

1. Unavailability affects only cases that include that staff; other staff book that day normally.
2. A blocked day is shown grey, unclickable, with the reason (e.g. "อ จักรกริช ไม่ว่าง"), not removed from the list.
3. Case with several staff: the day stays bookable if at least one staff on the case is available. The unavailable staff stays on the case (no auto edit); the UI shows a warning "อ X ไม่ว่างวันนี้" next to the day and at the confirm step.
4. Case with one staff who is unavailable: that day cannot be booked.
5. Existing bookings on a newly unavailable day are kept. Saving requires an explicit confirmation showing the affected cases (same flow as วันปิดรับคิว: 409 `requiresConfirmation` + `affectedBookings`, resend with `confirmExistingBookings`).
6. Entries are date ranges, full days only.
7. Reason is optional. Anyone using the app can add/delete (single shared login).
8. Applies to normal OR 17 days and OR Extra days alike.
9. Stored as an all-day Google Calendar event on hnbcmu's calendar, like วันปิดรับคิว, visible in the real calendar (e.g. "อ จักรกริช ไม่ว่าง").
10. Managed in the same tab as วันปิดรับคิว. The create form allows selecting several staff at once; the system stores one entry per staff.
11. Two ranges for the same staff may not overlap; the app rejects the save and tells the user to edit the existing entry.
12. Allowed dates: today through the end of the rolling 12-month horizon (same as closures). No past dates.
13. The "same_staff" booking preference does not count a day on which every selected staff is unavailable.
14. After saving, existing cases that clash keep a persistent warning badge on the case card and in the calendar ("อ X ไม่ว่าง ควรย้ายวัน") until the case is moved or the unavailable entry is deleted.
15. The rule is enforced server-side at booking, at move (สลับวัน), and in the post-write re-check.
16. Entries refer to staff by the display name as stored. If a staff is ever renamed, existing entries must be migrated by hand.
17. **Clash for existing cases (owner, 2026-11-08):** an existing case clashes when any staff on it is unavailable on its date; it does not matter that the other staff are free ("คนอื่นยังว่างไม่เกี่ยวข้องกัน"). Such a case is listed in the confirmation (decision 5) and carries the "ควรย้ายวัน" badge (decision 14). This is separate from the rule for choosing a day for a new booking or move (decisions 3 and 4), where one available staff is enough to allow the day with a warning.

18. **Move rule (owner, 2026-11-08, "ตาม doc"):** moving a case follows the same rule as a new booking. A destination day is allowed when at least one staff on the case is available, with a warning naming the unavailable staff; it is refused only when every staff on the case is unavailable. The stricter alternative (refuse any day where any staff is unavailable) was offered and declined.

## Calls made by Claude (owner to check while reading)

- **A. (Overridden by the owner, 2026-11-08 — now decision 17.)** An existing case clashes when *any* staff on it is unavailable on its date, whether or not the other staff are free. See decision 17.
- **B. Stored shape:** one calendar event per staff per range (multi-day all-day event, end date exclusive), new tag `or_queue=staff_unavailable`, private properties `staff`, `note`, `created_by`, `created_at`, `updated_by`.
- **C. Editing:** an entry can be edited (range, note); staff of an entry is not changed by editing (delete and re-create instead).
- **D. Errors:** the server returns a 409 with the Thai message naming the staff and date when a booking or move is refused for this reason.
- **E. Cases without a usable staff list:** a case with an empty staff list, or whose staff names do not match `STAFF_OPTIONS` (for example old or imported bookings), is never blocked and never badged. "Every staff unavailable" must not be treated as true for an empty list.
- **F. Multi-staff save with an overlap:** validate everything first and reject the whole save if any selected staff overlaps an existing range; the error names those staff. Nothing is written in that case. If a Calendar write fails part-way through a batch, best-effort remove the events just created and report the failure. The confirmation list (`affectedBookings`) is computed across all selected staff before anything is written.
- **G. Badge is computed live:** the "ควรย้ายวัน" badge and the clash list are derived on every load from the current entries and the current case dates. Nothing is stored on the case. A later entry or an edited range that makes a case a clash (any staff unavailable, decision 17) shows the badge; a delete or a move clears it. Consequence of decision 17 to be aware of: moving a clash case to another day where one of its staff is again unavailable but another staff is free is allowed (with warning) and the case stays badged.
- **H. Server reads Calendar on every booking and move, and fails closed:** if the unavailable events cannot be read, the booking or move is refused with a clear error rather than allowed through (anti-goal: no booking onto an unavailable day).
- **I. Editing an entry:** the overlap check applies (excluding the entry itself), and if the new range newly covers a day with a clashing case, the same confirmation flow as creation applies.
- **J. "Today" and dates:** use the app's existing `dateOnly()` convention for today and for the horizon, and ISO `YYYY-MM-DD` dates. All-day events use an exclusive end date (end = last day + 1).
- **K. same_staff:** this is the existing `staffQueuePreference` ("any" / "same_staff") in the booking form. For a multi-staff case a day is excluded only when every selected staff is unavailable (same rule as the booking block).

## Constraints

- Next.js in this repo has breaking changes: read the relevant guide in `node_modules/next/dist/docs/` before writing code (see `AGENTS.md`).
- Staff list is duplicated in `app/lib/schedule.ts` (`STAFF_OPTIONS`) and `app/SchedulerApp.tsx` (`STAFF`); keep one source of truth or keep both in sync.
- Existing rule check `destinationError` (`app/lib/queue.ts`) is shared by booking and move and currently ignores staff; extend it rather than adding a parallel check.
- Closure code is the pattern to follow: `app/api/schedule-closures/route.ts`, `saveScheduleClosureEvent` / `listTaggedEvents` / `listCalendarData` in `app/lib/calendar.ts`.
- Google Calendar access is server-held (`GOOGLE_REFRESH_TOKEN`); never print or commit secrets.
- Checks before done: `npm test`, `npx tsc --noEmit`, `npx eslint auth.ts app scripts tests`. `next dev` on this Google Drive folder is very slow and rewrites `next-env.d.ts` (revert).
- No push or deploy without the owner's go. Push needs `gh auth switch -u chagkrit`, then switch back to `residentsurgcmu`.

## Enforcement points (all three must use the same rule)

1. Booking: POST `/api/schedule` (candidate days, `alternativeDays`, `manualMinDate`, error messages) and the client lists `availableDays` and `availabilityFor`.
2. Move: PATCH `/api/cases/[id]/move` (it already loads `booking.staffMembers`) and the client list `moveDates`.
3. Post-write re-check: after writing a booking or move, re-verify and undo if the day became invalid, as is done today for closed or overfull days.

Rule: refuse when every staff on the case is unavailable on that date; otherwise allow and surface a warning listing the unavailable staff.

## Acceptance scenarios

1. Case staff = [อ จักรกริช]; date 2027-03-04 with an entry for อ จักรกริช: day is grey with reason; POST booking returns 409; move to that day returns 409.
2. Same day, case staff = [อ กีรติ]: day is selectable and booking succeeds.
3. Case staff = [อ จักรกริช, อ กีรติ] on that day: selectable with warning naming อ จักรกริช; booking succeeds; staff list unchanged.
4. Range 3–5 Mar entered, then 5–7 Mar for the same staff: second save rejected (overlap); different staff with the same dates is fine.
5. Entry created on a day that already has an existing case whose only staff is the unavailable one: first save returns the confirmation list; after confirming, the case stays and shows the "ควรย้ายวัน" badge; moving it away or deleting the entry clears the badge.
6. Entry on a day where an existing case has staff [A, B] and only A unavailable: the case IS listed in the confirmation and gets the "ควรย้ายวัน" badge (decision 17). A new booking of a case [A, B] on that same day is still allowed with the warning (decision 3).
7. Entry for a past date or beyond the horizon: rejected.
8. Two browser pages: page 1 loaded before the entry was created books onto the blocked day: server refuses.
9. "same_staff" preference with a staff unavailable that day: that day is not offered as a "same staff" day.
10. OR Extra day (Monday/Thursday extra event) with an entry: blocked the same way.
11. Delete an entry: day becomes selectable again; calendar event removed.

## Left to the builder

- Event id scheme and how edit changes the range (deterministic vs random id).
- Exact API route names and request shape, UI layout inside the closure tab, badge styling (follow `design-system/operative-schedule/MASTER.md`).
- Whether to fetch the new events in the same Calendar call as other tags.
- How multi-day events are fetched for a date window (make sure ranges that start before the window are included).
- Test structure (existing tests are in `tests/app-rules.test.mjs`).
