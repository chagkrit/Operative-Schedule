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
