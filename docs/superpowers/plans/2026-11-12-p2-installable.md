# P2 — Installable App (PR-B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OR Queue can be added to the iPhone/Android home screen and opens full screen with the unit logo icon, name and theme colour.

**Architecture:** Next 16 `app/manifest.ts` file convention + PNG icons generated once from `public/unit-logo.jpg` with macOS `sips` (script committed) + `viewport.themeColor` and `metadata.appleWebApp` in `app/layout.tsx`. No service worker.

**Tech Stack:** Next.js 16 metadata API (read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/manifest.md` and `app-icons.md`, and `04-functions/generate-viewport.md` before coding), `sips`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-12-p1-p2-world-class-feel-design.md` §5 (§5.2: no service worker, owner decision)

## Global Constraints

- **No service worker**, no `serviceWorker.register`, no `sw.js`, no caching of `/api/*` or `/` (owner: never store patient data on the device).
- Manifest values (spec §5.1): name `OR Queue — Breast & Endocrine Surgery CMU`, short_name `OR Queue`, `start_url: "/?tab=schedule"`, `display: "standalone"`, `background_color: "#fbf4f6"`, `theme_color: "#a71955"`, `lang: "th"`.
- Icons from `public/unit-logo.jpg` (2048×2080, no alpha), padded to square on white (`FFFFFF`): `public/icons/icon-192.png`, `public/icons/icon-512.png`, `public/icons/icon-maskable-512.png` (logo ≈ 80% of canvas for the maskable safe zone), `public/icons/apple-touch-icon-180.png`. Never upscale beyond the source.
- Keep the existing `icons: { icon: "/unit-logo.jpg", shortcut: "/unit-logo.jpg" }` in metadata and add `apple: "/icons/apple-touch-icon-180.png"`. Do not add `app/icon.*` / `app/apple-icon.*` files (would duplicate the explicit metadata icons).
- `themeColor` goes in `viewport` (Next 16), keeping `viewportFit: "cover"`. `appleWebApp: { capable: true, title: "OR Queue", statusBarStyle: "default" }` in metadata.
- No custom install button / install hint card in this PR (YAGNI; spec made it optional).
- Do not touch `SchedulerApp.tsx`, API routes, auth.
- Repo checks: `npm test`, `npx tsc --noEmit`, `npx eslint auth.ts app scripts tests`, `npx next build`. Revert `next-env.d.ts` if changed.
- Commit trailer:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01PFJ12YBXX3uCgDkEsPxXDA
  ```
- Never push/merge without the owner's go.

## Review Focus

1. The manifest route must be reachable signed-out (there is no middleware/proxy; confirm `next build` lists `/manifest.webmanifest` as a static route). → Task 2 build check.
2. Icons look right on a white iOS home screen (logo not cropped in the maskable). → Task 1 visual check (Read the PNGs).
3. Safe areas in standalone mode (top bar, bottom nav) — existing CSS uses `env(safe-area-inset-*)`; real iPhone only. → owner check.
4. Google sign-in inside the installed app (iOS standalone cookie jar) — real iPhone only, must pass before merge. → owner check.

---

### Task 1: Icons + generator script

**Files:**
- Create: `scripts/make-icons.sh`, `public/icons/icon-192.png`, `public/icons/icon-512.png`, `public/icons/icon-maskable-512.png`, `public/icons/apple-touch-icon-180.png`
- Test: `tests/p2-installable.test.mjs`

- [ ] **Step 1: Failing test** `"app icons exist at the declared sizes"`: for each file, read the PNG header (bytes 16–23 = width/height big-endian) and assert 192×192, 512×512, 512×512, 180×180.
- [ ] **Step 2:** `node --test tests/p2-installable.test.mjs` → FAIL (files missing).
- [ ] **Step 3:** `scripts/make-icons.sh` (bash, `set -euo pipefail`, uses only `sips`, writes to a temp dir then `public/icons/`): pad source to 2080×2080 white → resample to 512/192/180 (`-s format png`); maskable: pad to 2600×2600 white → resample 512. Run it.
- [ ] **Step 4:** Test passes; Read each PNG to eyeball (logo centred, maskable has margin).
- [ ] **Step 5:** Commit `feat: home-screen icons from unit logo`.

### Task 2: Manifest + iOS metadata

**Files:**
- Create: `app/manifest.ts`
- Modify: `app/layout.tsx` (viewport, metadata icons/appleWebApp)
- Test: `tests/p2-installable.test.mjs`

- [ ] **Step 1: Failing tests:**
  - `"manifest declares the installable app"`: import-free source check of `app/manifest.ts` — matches `short_name: "OR Queue"`, `display: "standalone"`, `start_url: "/?tab=schedule"`, `theme_color: "#a71955"`, `background_color: "#fbf4f6"`, `"maskable"`, and all three `/icons/icon-*.png` paths.
  - `"layout sets theme colour and iOS web-app meta"`: `app/layout.tsx` matches `themeColor: "#a71955"`, `viewportFit: "cover"`, `appleWebApp`, `capable: true`, `apple: "/icons/apple-touch-icon-180.png"`.
  - `"no service worker in this PR"`: no file under `app/` or `public/` contains `serviceWorker.register`, and `public/sw.js` does not exist.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** `export default function manifest(): MetadataRoute.Manifest` with the Global Constraints values; icons: 192 (`purpose: "any"`), 512 (`any`), maskable 512 (`purpose: "maskable"`). Update layout `viewport` and `generateMetadata` return.
- [ ] **Step 4:** All repo checks incl. `next build` (output lists `○ /manifest.webmanifest`).
- [ ] **Step 5:** Commit `feat: web app manifest and iOS home-screen meta`.

### Task 3: Verify, handoff, PR on owner go

- [ ] **Step 1:** Repo checks green on HEAD.
- [ ] **Step 2:** Handoff section (commits, checks, iPhone must-test list: Add to Home Screen → icon/name, opens full screen, status bar colour, Google sign-in works inside the installed app, bottom nav/top bar safe areas, /privacy link stays in-app).
- [ ] **Step 3:** On owner go: push → PR → preview → owner tests on iPhone → merge on owner's word. Rollback = Vercel promote 797dad8.
