# UI/UX Review Findings — OR Queue (baseline, before changes)

Date: 2026-10-08
Method: temporary `/preview` route (mocked `/api/*`, 13 upcoming OR 17 days, 3 recent moves), Chromium 390×844 and 1280×800 at 2× DPR, `audit.mjs` (counts visible text nodes under 12px and interactive elements under 44px in either dimension), plus visual inspection of the full-page phone screenshot.

Baseline numbers (distinct `font-size + element` keys / interactive keys):

| Viewport | Page height | Small-text keys | Small-target keys | Horizontal overflow |
|---|---|---|---|---|
| 390×844 | 4,498px | 32 | 11 | no |
| 1280×800 | 2,098px | 33 | 11 | no |

## Findings

| Severity | Area | Finding | Evidence | Planned in task |
|---|---|---|---|---|
| High | Navigation (phone) | One 4,498px page: the booking form starts below the entire upcoming-queue list (schedule panel has `order: -1` at ≤1000px), and case search / move alerts are at the very bottom. Reaching the primary task needs long scrolling. | full-page screenshot `audit-phone390.png`; page height 4,498px | Task 5 — **fixed**: ตาราง screen 2,540px (was 4,498px); booking, search and alerts are one tap away (`verify.mjs nav` 29/29) |
| High | Top bar (phone) | Sync / Export / ออกจากระบบ are 30px tall with 9px labels, crammed beside the calendar pill. | `69x30 button.sync-button`, `74x30 button.export-button`, `73x30 button.signout-button`; `9px button.sync-button` etc. | Task 6 + 7 — **fixed**: moved into the เมนู disclosure, 44px+ tall at 14px (`verify.mjs menu`) |
| High | Schedule tabs (phone) | รายการคิว / ปฏิทินรายเดือน / วันปิดรับคิว tabs are 32–35px tall with 8–9px labels. | `158x32 button.active`, `103x35 button`, `8px button.active`, `9px button.active` | Task 7 — **fixed** (`verify.mjs polish`, all four tabs) |
| High | Booking form text | Field help, labels, staff names, legends at 9–11px on the primary data-entry flow. | `9px small.field-help`, `11px legend`, `11px label`, `11px span.neoadjuvant-choice` | Task 7 — **fixed** (`verify.mjs polish`, all four tabs) |
| High | Inputs (phone) | Date inputs 34px tall; text inputs use the inherited small size, so iOS Safari zooms the page on focus (< 16px). | `147x34 input` ×2 | Task 7 — **fixed** (`verify.mjs polish`, all four tabs) |
| Medium | Queue cards | Booking rows, slot markers and times at 8–10px (`#1` markers 9px; HN/time lines 8px). | `8px small` ×74, `9px span.cancer-mark` ×24, `10px span` ×34 | Task 7 — **fixed** (`verify.mjs polish`, all four tabs) |
| Medium | Status lines | Last-sync line, history count, search scope at 9px. | `9px p.last-sync`, `9px span.history-count`, `9px span.search-scope` | Task 7 — **fixed** (`verify.mjs polish`, all four tabs) |
| Medium | Move history | Times at 8px. | `8px time` ×3 | Task 7 — **fixed** (`verify.mjs polish`, all four tabs) |
| Medium | Secondary buttons | "+ กำหนด OR Extra" 31px tall at 11px. | `115x31 button.text-button`, `11px button.text-button` | Task 7 — **fixed** (`verify.mjs polish`, all four tabs) |
| Low | Checkboxes | Staff / neoadjuvant checkboxes are 16×16px, but their labels are clickable rows, so the effective target is larger. | `16x16 input` ×7 | not planned (label rows already act as the target) |
| Low | Desktop | Same small-text pattern on desktop (33 keys). | desktop audit | not planned (spec: desktop unchanged) |

No horizontal overflow was found at either width.

## After the changes (2026-10-08)

| Viewport | Page height (ตาราง) | Small-text keys | Small-target keys | Horizontal overflow |
|---|---|---|---|---|
| 390×844 | 2,540px (was 4,498px) | 0 (was 32) | 0 (was 11) | no |
| 1280×800 | 2,098px (unchanged) | 33 (unchanged, by design) | 11 (unchanged, by design) | no |

`verify.mjs polish` checks every tab at 390px: no text under 12px (7-column calendar cell micro-labels exempt at a 10px floor), no control under 44px tall, no text input under 16px, no horizontal overflow — 16/16 pass. One rule needed `!important` because `globals.css` already sets `.neoadjuvant-choice` with `!important`.
