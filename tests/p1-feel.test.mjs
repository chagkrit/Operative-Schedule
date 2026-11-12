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
