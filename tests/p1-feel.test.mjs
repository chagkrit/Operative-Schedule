import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("shows skeletons only on the first load", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const css = await read("app/aurora.css");
  assert.match(app, /loading && !data \? <QueueSkeleton \/>/);
  assert.match(app, /<CalendarSkeleton \/>/);
  assert.doesNotMatch(app, /className="empty-state">กำลังโหลดคิว…/);
  assert.match(css, /\.orq-skeleton/);
  assert.match(css, /prefers-reduced-motion[\s\S]*orq-skeleton/);
});

test("quiet refresh never raises the alert notice", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const start = app.indexOf("const loadSchedule = useCallback");
  assert.ok(start >= 0, "loadSchedule not found");
  const end = app.indexOf("}, []);", start);
  assert.ok(end > start, "end of loadSchedule not found");
  const body = app.slice(start, end);
  assert.match(body, /if \(quiet\) \{\s*setRefreshFailed\(true\)/);
  assert.match(body, /status === 401/);
  assert.match(body, /setRefreshFailed\(false\)/);
  assert.ok(body.indexOf("status === 401") < body.indexOf("if (quiet)"), "401 branch must come before the quiet branch");
});

test("a quiet load never touches the loading flag", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const start = app.indexOf("const loadSchedule = useCallback");
  const end = app.indexOf("}, []);", start);
  assert.match(app.slice(start, end), /if \(!quiet\) setLoading\(false\)/);
});

test("quiet refresh is gated and event-driven", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /shouldRefreshQuietly\(/);
  assert.ok((app.match(/addEventListener\("visibilitychange"/g) || []).length >= 2, "needs a visibilitychange listener besides presence");
  assert.match(app, /addEventListener\("focus"/);
  assert.match(app, /addEventListener\("online"/);
  assert.match(app, /REFRESH_INTERVAL_MS/);
  assert.match(app, /lastFormEditAtRef/);
});

test("freshness line uses the shared label and offers retry", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /freshnessLabel\(/);
  assert.match(app, /className=\{`last-sync \$\{/);
  assert.match(app, />ลองใหม่</);
  assert.doesNotMatch(app, /อัปเดตจาก Google Calendar ล่าสุด/);
});

test("keeps a refreshed-away date and says so", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /const requestedDateStale = /);
  assert.match(app, /วันที่เลือกเต็มหรือปิดแล้ว กรุณาเลือกวันใหม่/);
  assert.match(app, /<small className="field-help field-warning" role="status">/);
});

test("flags a case changed on another device, but not past cases", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const start = app.indexOf("const selectedCaseStale = ");
  assert.ok(start >= 0, "selectedCaseStale must exist");
  const expr = app.slice(start, app.indexOf(");", start));
  assert.match(expr, /selectedCase\.scheduleDate >= data\.horizonStart/);
  assert.match(app, /เคสนี้ถูกแก้จากอีกเครื่อง กรุณาค้นหาใหม่/);
  assert.ok((app.match(/disabled=\{[^}]*selectedCaseStale/g) || []).length >= 3, "move, edit and delete must be disabled");
});

test("uses the Aurora confirm dialog instead of window.confirm", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const dialog = await read("app/ConfirmDialog.tsx");
  assert.doesNotMatch(app, /window\.confirm/);
  assert.match(app, /<ConfirmDialog/);
  assert.ok((app.match(/setConfirmDialog\(/g) || []).length >= 2);
  assert.match(dialog, /role="alertdialog"/);
  assert.match(dialog, /aria-modal="true"/);
});

test("replaces the post-booking Sync modal with a confirmed message", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.doesNotMatch(app, /showSyncPrompt/);
  assert.doesNotMatch(app, /confirmSyncAfterBooking/);
  assert.doesNotMatch(app, /syncPromptButtonRef/);
  assert.match(app, /ยืนยันกับ Google Calendar แล้ว/);
  assert.match(app, /แต่ยังยืนยันกับ Google Calendar ไม่ได้/);
});

test("busy buttons announce and show a spinner", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const css = await read("app/aurora.css");
  assert.ok((app.match(/aria-busy=\{/g) || []).length >= 6);
  assert.match(css, /button\[aria-busy="true"\]::before/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*button\[aria-busy="true"\]::before \{ animation: none/);
});

test("spinner and skeleton borders survive the global border reset", async () => {
  const css = await read("app/aurora.css");
  const start = css.indexOf('button[aria-busy="true"]::before {');
  const rule = css.slice(start, css.indexOf("}", start));
  assert.match(rule, /border: 2px solid currentColor !important;/);
  assert.match(rule, /border-right-color: transparent !important;/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*button\[aria-busy="true"\]::before \{ animation: none; border-right-color: currentColor !important;/);
  const skStart = css.indexOf(".orq-skeleton {");
  assert.match(css.slice(skStart, css.indexOf("}", skStart)), /border: 1px solid var\(--hairline\) !important;/);
});

test("stale notes only judge a selection against data loaded after it", async () => {
  const app = await read("app/SchedulerApp.tsx");
  const dateStart = app.indexOf("const requestedDateStale = ");
  const dateExpr = app.slice(dateStart, app.indexOf(");", dateStart));
  assert.match(dateExpr, /requestedDateChosenAt !== null && lastSyncedAt && lastSyncedAt\.getTime\(\) > requestedDateChosenAt/);
  const caseStart = app.indexOf("const selectedCaseStale = ");
  const caseExpr = app.slice(caseStart, app.indexOf(");", caseStart));
  assert.match(caseExpr, /searchedAt !== null && lastSyncedAt && lastSyncedAt\.getTime\(\) > searchedAt/);
  assert.match(app, /setSearchResults\(results\);\s*setSearchedAt\(Date\.now\(\)\);/);
  // Every way of picking a date stamps the pick time: cancer list, OR17 list, manual calendar, 409 suggestion.
  for (const fn of ["chooseCancerDate", "chooseListDate", "chooseManualDate", "chooseSuggestedQueue"]) {
    const s = app.indexOf(`function ${fn}(`);
    assert.ok(s >= 0, `${fn} must exist`);
    assert.match(app.slice(s, app.indexOf("\n  }\n", s)), /noteRequestedDateChosen\(/, `${fn} must stamp the pick time`);
  }
  assert.match(app, /onChange=\{\(e\) => chooseListDate\(e\.target\.value\)\} aria-label="เลือกวัน OR 17"/);
});

test("freshness clock catches up on focus and retry announces busy", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /const tryQuietRefresh = \(\) => \{\s*setNow\(Date\.now\(\)\);/);
  assert.match(app, /aria-busy=\{syncing\} onClick=\{\(\) => void syncCalendar\(\)\} disabled=\{syncing\}>ลองใหม่</);
});

test("first load blocks the quiet refresh and failed first load shows no skeleton", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /busy: loading \|\| saving/);
  assert.match(app, /\{loading && !data && <CalendarSkeleton \/>\}/);
  assert.doesNotMatch(app, /: <CalendarSkeleton \/>/);
});

test("dead manual-date-loading CSS is gone", async () => {
  for (const file of ["app/globals.css", "app/mobile-shell.css", "app/SchedulerApp.tsx"]) {
    assert.doesNotMatch(await read(file), /manual-date-loading/, file);
  }
});
