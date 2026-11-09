# Case duration and 360-minute daily limit (ระยะเวลาผ่าตัดต่อเคส) — design

Status: DRAFT for owner approval, 2026-11-09. Nothing is built. Vocabulary: see `GLOSSARY.md`.

## Intent and why

Today a room-day (one OR 17 day, or one OR Extra day) is limited only by case count (capacity 4, `app/lib/queue.ts`). Four long cases can be booked into one day even though the room cannot finish them. The owner wants each case to carry its expected operating time in minutes, and each room-day to hold at most **360 minutes** in total. A room-day that would exceed 360 minutes must refuse the case **even if it has only 3 cases** (still under the 4-case cap), and the user must see a popup that says why.

## Goals

- Every new booking records an operating time in whole minutes, typed by the user.
- Each room-day holds at most 360 minutes of cases; booking, moving (สลับวัน) and editing a case's duration are all refused when the result would exceed 360.
- The refusal is shown in a popup (modal) that explains the reason with numbers.
- A case's duration can be edited after booking, with the same 360 check.
- Existing (pre-feature) bookings keep working without anyone back-filling durations.

## Non-goals

- Changing the 4-case cap, the "OR 17 needs at least 1 Cancer / last slot Cancer-only" rule, closures, or staff-unavailability rules. All existing rules stay and run alongside the new one.
- Editing any other field of a case (diagnosis, staff, HN…). Only duration becomes editable.
- Start/end clock times, turnover time, or reordering cases by time.
- Back-filling durations on old cases automatically.
- Per-room or per-day configurable limits (360 is a fixed constant for both rooms).

## Anti-goals (failure even if it "works")

- A room-day that is enforced ending up over 360 minutes through any path (book, move, edit, simultaneous saves, a stale open browser page).
- Blocking work on days that already had cases before the feature (owner: those days do not use the rule).
- Silent refusal: the user must always see why the save failed.

## Decisions made by the owner (2026-11-09)

1. The user types the duration as a number of minutes (free number entry, not preset buttons).
2. Limit is 360 minutes per room per day.
3. Applies to **both OR 17 and OR Extra**.
4. Counted **separately per room**: on a Thursday with both rooms open, OR 17 has its own 360 and OR Extra has its own 360.
5. If adding the case would exceed 360, it cannot be booked, even when the day has only 3 cases; show a popup that says why.
6. **Existing days:** "ถ้ามีลงไว้ก่อน วันนั้นยังไม่เริ่มใช้ เริ่มใช้เมื่อห้องว่างยังไม่มีเคสเลย" — a room-day that already has cases booked before the feature does not use the 360 rule; the rule starts on room-days that are empty, so every case on them has a duration.
7. Moving a case (สลับวัน) must check the 360 rule on the destination.
8. Add a way to edit the duration of an already-booked case; the edit also checks the 360 rule.

## Calls made by Claude (owner to check while reading)

- **A. When the rule applies to a room-day.** A room-day is *enforced* when every booking on it, after the change, has a duration. If any booking on that room-day has no duration (a pre-feature case), the 360 rule is skipped for that room-day. This is how decision 6 is implemented: old days contain old cases without duration, so they are skipped; empty days only ever receive cases with duration, so they are enforced. Consequence: if every old case on a day is later deleted or given a duration, that day becomes enforced from then on.
- **B. Closing the loophole for old cases being moved.** Under call A, moving an old case (no duration) into an enforced day would make that day un-enforced. To prevent this, a case without a duration **cannot be moved until it has one**: the move dialog shows a required duration field for such cases, and the move request carries it; the server saves the duration together with the move and checks 360 on the destination. (Confirmed by the owner — decision 9.)
- **C. Input rules.** Required on every new booking. Whole number, 1–360. Thai error messages: "กรุณากรอกระยะเวลาผ่าตัดเป็นนาที" (empty), "ระยะเวลาผ่าตัดต้องเป็นจำนวนเต็ม 1–360 นาที" (out of range / not an integer). Mobile keyboard numeric (`inputMode="numeric"`).
- **D. Popup content.** One modal dialog (same visual pattern as the existing delete-confirmation dialog in `app/SchedulerApp.tsx`), title "ลงคิวไม่ได้: เวลาผ่าตัดรวมเกิน 360 นาที" (or "สลับวันไม่ได้…" / "แก้ระยะเวลาไม่ได้…"), body with numbers: room + Thai date (พ.ศ.), minutes already booked, minutes left, this case's minutes, minutes over. Example: "OR 17 วันพฤหัสบดีที่ 12 พ.ย. 2569 ลงไว้แล้ว 300 นาที เหลือ 60 นาที เคสนี้ 90 นาที เกิน 30 นาที". One button "ตกลง". The server returns these numbers in a structured 409 body (e.g. `{ error, reason: "minutes_exceeded", minutes: { booked, remaining, requested, limit: 360 } }`); the client builds the popup from it. Other existing errors keep their current display.
- **E. Earliest-queue for Cancer ("คิวเร็วที่สุด").** Days where this case would not fit are skipped, so the system picks the first day that fits by count, clinical rules, staff and minutes. The "คิวว่างเร็วที่สุด" preview in the form uses the typed duration too. The alternative-day suggestions (`suggestions`) also skip days that don't fit.
- **F. Day lists show remaining time.** In the date drop-down and on schedule day cards, an enforced room-day shows "เหลือ X นาที" (or "ใช้ไป Y/360 นาที" on the schedule card). A room-day with old cases shows nothing about minutes. Days where the typed duration doesn't fit stay visible; choosing one and saving gives the popup (decision 5). Whether to also grey them out is left to the builder only if it doesn't remove the popup path; default: do not grey, only show remaining minutes.
- **G. Server enforcement and races.** Checked on the server for book (`POST /api/schedule`), move (`PATCH /api/cases/[id]/move`) and duration edit (new endpoint, see H), and again in the existing post-write re-check: after writing, re-read the room-day; if it is enforced and over 360, undo this write (delete the new booking / restore the moved case / restore the old duration) and return the popup error. Same pattern as the existing count and staff re-checks.
- **H. Editing duration.** New `PATCH /api/cases/[id]` with `{ durationMinutes }` (the route file already has `DELETE`). Allowed for today and future cases only (same as delete). Check: apply call A to the room-day with the new value; if enforced and total > 360, refuse with the popup. UI: an "แก้ระยะเวลา" action on the case where the existing move/delete actions are (search result card), opening a small dialog with the number field prefilled.
- **I. Storage.** New private extended property `duration_minutes` on the booking event (string of the integer; absent or empty = no duration). Also a line `ระยะเวลาผ่าตัด: N นาที` in the event description so it is visible in Google Calendar. `CalendarBooking` gets `durationMinutes: number | null`. The calendar event's clock time stays as today (slot-based hourly block, `bookingEventTiming`); it is not stretched to the duration.
- **J. Display.** Case cards (schedule, search, recent moves where a case is shown) show "N นาที" when present, nothing when absent. The Excel export (`app/api/wait-time-export`) gets a column "ระยะเวลาผ่าตัด (นาที)", empty for old cases.
- **K. Where the rule lives.** Pure function next to `destinationError` in `app/lib/destination.ts` (no Calendar imports, testable), e.g. `minutesError(dayBookings, change)` returning null or the numbers for the popup. `DaySummary` gains `bookedMinutes` and `enforced` (all bookings have duration). Constant `DAILY_MINUTES_LIMIT = 360`.
- **L. Move of a case that already has a duration** keeps its duration unchanged.

9. **(Owner, 2026-11-09, builder-check round)** Call B confirmed: an old case without a duration must be given one before it can be moved (required field in the move dialog, saved with the move, checked against 360 on the destination). A failed move (post-write re-check) restores both the old date and the old (empty) duration.
10. **(Owner, 2026-11-09)** Nobody enters cases directly in Google Calendar any more; all bookings go through the app. Untagged legacy events that `parseLegacyCalendarEvent` still reads count as "no duration" under call A (their room-day is not enforced); no extra handling, and the edit endpoint is not required to support them (it may refuse untagged legacy events with a clear message).

- **M. Edits on a day that becomes enforced while already over 360 (Claude's call, from builder check).** The minutes check refuses a change only when, after the change, the room-day is enforced **and** its total is over 360 **and** the change raises that room-day's known total (booking in, moving in, or increasing a duration). So: shortening a duration is always allowed; moving a case *out* is never blocked by minutes; and setting a duration on a case that had none (edit endpoint) is always allowed, even if that makes an old day enforced and over 360 — the owner never blocks work on a pre-feature day. Such a day shows "ใช้ไป Y/360 นาที" (over) and simply refuses further increases until it is back under. The post-write re-check uses the same rule.

## Open for the owner

- None (builder check round done 2026-11-09).

## Left to the builder

- Exact component structure, CSS, and wording polish of messages not quoted above.
- Test layout, following existing `tests/*.test.mjs` (pure-rule tests for the minutes function, wiring tests like `staff-unavailability-wiring.test.mjs`).
- Checks before done (from project CLAUDE.md): `npm test`, `npx tsc --noEmit`, `npx eslint auth.ts app scripts tests`. Branch first; never push/deploy without the owner's go.
