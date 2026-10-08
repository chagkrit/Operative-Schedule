import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const channel = (value) => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const token = (css, name) => css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];

test("bottom bar is a labelled nav of links with aria-current and no push animation", async () => {
  const nav = await read("app/BottomNav.tsx");
  assert.match(nav, /<nav className="bottom-nav" aria-label="เมนูหลัก">/);
  assert.match(nav, /aria-current=\{isActive \? "page" : undefined\}/);
  assert.match(nav, /href=\{tabHref\(tab\)\}/);
  assert.match(nav, /aria-hidden="true"/);
  assert.doesNotMatch(nav, /next\/link/);
  for (const label of ["ตาราง", "ลงคิว", "ค้นหา", "แจ้งเตือน"]) assert.match(nav, new RegExp(label));
});

test("bar clears the iPhone home indicator and is phone-only", async () => {
  const css = await read("app/mobile-shell.css");
  const layout = await read("app/layout.tsx");
  assert.match(css, /padding-bottom: env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.bottom-nav[^{]*\{[^}]*display: none/);
  assert.match(css, /@media \(max-width: 1000px\)/);
  assert.match(layout, /viewportFit: "cover"/);
  assert.match(layout, /import "\.\/mobile-shell\.css"/);
});

test("bar labels are at least 12px, links at least 44px tall, and there is no transition", async () => {
  const css = await read("app/mobile-shell.css");
  const bar = css.slice(css.indexOf("@media (max-width: 1000px)"));
  assert.match(bar, /\.bottom-nav-link\s*\{[^}]*font-size: 12px/);
  assert.match(css, /--bottom-nav-height: 64px/);
  assert.match(bar, /min-height: var\(--bottom-nav-height\)/);
  assert.doesNotMatch(css.slice(css.indexOf(".bottom-nav-link")), /transition:/);
});

test("bar text and icon colours keep 4.5:1 contrast on the soft surface", async () => {
  const css = await read("app/mobile-shell.css");
  const globals = await read("app/globals.css");
  const surface = token(globals, "--soft-base");
  assert.equal(surface, "#e0e5ec");
  for (const name of ["--bottom-nav-muted", "--bottom-nav-active"]) {
    const colour = token(css, name);
    assert.ok(colour, `${name} defined`);
    assert.ok(contrast(colour, surface) >= 4.5, `${name} ${colour} contrast ${contrast(colour, surface).toFixed(2)}`);
  }
});

test("SchedulerApp maps every screen to a tab and switches with replaceState", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const page = await read("app/page.tsx");
  assert.match(app, /parseTab\(searchParams\.get\("tab"\)\)/);
  assert.match(app, /window\.history\.replaceState\(null, "", tabHref\(tab\)\)/);
  assert.match(app, /<main className="app-shell" data-screen=\{activeTab\}>/);
  assert.match(app, /className="hero" data-screens="schedule"/);
  assert.match(app, /className="workspace-grid" data-screens="book schedule"/);
  assert.match(app, /className="panel booking-panel" id="screen-book" tabIndex=\{-1\} data-screens="book"/);
  assert.match(app, /className="panel schedule-panel" id="screen-schedule" tabIndex=\{-1\} data-screens="schedule"/);
  assert.match(app, /className="case-tools-grid" data-screens="search alerts"/);
  assert.match(app, /className="panel case-search-panel" id="screen-search" tabIndex=\{-1\} data-screens="search"/);
  assert.match(app, /className="panel move-history-panel" id="screen-alerts" tabIndex=\{-1\} data-screens="alerts"/);
  assert.match(app, /<BottomNav active=\{activeTab\} unseenAlerts=\{unseen\} onSelect=\{selectTab\} \/>/);
  assert.match(page, /<Suspense/);
});

test("a successful phone booking returns to ตาราง without stealing focus, and own moves are marked seen", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /matchMedia\("\(max-width: 1000px\)"\)\.matches\) selectTab\("schedule", \{ focus: false \}\)/);
  const moveCase = app.slice(app.indexOf("async function moveCase"), app.indexOf("const deleteHnMatches"));
  assert.match(moveCase, /markOwnMove\(payload\.move!\.id, payload\.move!\.movedAt\)/);
  assert.doesNotMatch(moveCase, /markSeen\(\)/);
});

test("inactive screens are removed from layout (and the focus order) only on phones and tablets", async () => {
  const css = await read("app/mobile-shell.css");
  for (const tab of ["schedule", "book", "search", "alerts"]) {
    assert.match(css, new RegExp(`\\.app-shell\\[data-screen="${tab}"\\] \\[data-screens\\]:not\\(\\[data-screens~="${tab}"\\]\\)`));
  }
  const phone = css.slice(css.indexOf("@media (max-width: 1000px)"));
  assert.match(phone, /\[data-screens\][^{]*\{[^}]*display: none/);
  assert.doesNotMatch(css.slice(0, css.indexOf("@media (max-width: 1000px)")), /data-screens/);
});

test("top bar collapses into an accessible menu disclosure on phones", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const css = await read("app/mobile-shell.css");
  assert.match(app, /className="menu-button" type="button" aria-expanded=\{menuOpen\} aria-controls="topbar-menu"/);
  assert.match(app, /id="topbar-menu" className="topbar-actions" data-open=\{menuOpen\}/);
  assert.match(app, /event\.key !== "Escape"/);
  assert.match(app, /menuButtonRef\.current\?\.focus\(\)/);
  assert.match(css, /\.menu-button\s*\{[^}]*display: none/);
  assert.match(css, /\.topbar \.topbar-actions\[data-open="true"\]/);
  assert.match(app, /Sync ทันที/);
});

test("phone polish sets the text, target and input-zoom floors", async () => {
  const css = await read("app/mobile-shell.css");
  const polish = css.slice(css.indexOf("Phone polish"));
  assert.match(polish, /@media \(max-width: 650px\)/);
  assert.match(polish, /\.field span[\s\S]*?\{\s*font-size: 12px;/);
  assert.match(polish, /min-height: 44px;\s*font-size: 12px/);
  assert.match(polish, /\.field input[\s\S]*?\{\s*min-height: 44px;\s*font-size: 16px;/);
  assert.match(polish, /\.month-legend em \{\s*font-size: 10px;/);
});

test("every sub-12px !important font rule in globals.css is overridden on phones", async () => {
  const globals = await read("app/globals.css");
  const css = await read("app/mobile-shell.css");
  const important = [...globals.matchAll(/([^{}]+)\{[^}]*font-size:\s*(\d+(?:\.\d+)?)px\s*!important/g)]
    .filter((m) => Number(m[2]) < 12)
    .map((m) => m[1].trim());
  assert.ok(important.length >= 2, important.join(" | "));
  for (const selector of important) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(css, new RegExp(`${escaped}[^{]*\\{[^}]*font-size: 12px !important`), selector);
  }
});

test("manual-date month arrows meet the 44px target on phones", async () => {
  const css = await read("app/mobile-shell.css");
  const polish = css.slice(css.indexOf("Phone polish"));
  assert.match(polish, /\.manual-date-toolbar \{ grid-template-columns: 44px 1fr 44px; \}/);
  assert.match(polish, /\.manual-date-toolbar button \{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
});

test("viewport-fit=cover is paired with safe-area insets for the bar, the shell and bottom-sheet dialogs", async () => {
  const css = await read("app/mobile-shell.css");
  assert.match(css, /\.bottom-nav \{[^}]*padding-left: env\(safe-area-inset-left\);[^}]*padding-right: env\(safe-area-inset-right\);/);
  assert.match(css, /\.app-shell \{[^}]*padding-left: max\(14px, env\(safe-area-inset-left\)\);[^}]*padding-right: max\(14px, env\(safe-area-inset-right\)\);/);
  assert.match(css, /\.queue-conflict-backdrop \{[^}]*padding-bottom: max\(10px, env\(safe-area-inset-bottom\)\);/);
});
