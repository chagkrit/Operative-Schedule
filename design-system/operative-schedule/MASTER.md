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
