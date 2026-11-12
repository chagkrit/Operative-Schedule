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
