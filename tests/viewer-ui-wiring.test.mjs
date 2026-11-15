import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// Body of `async function name(` up to the next top-level function.
function handlerBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = source.indexOf("\n  async function ", start + 10);
  const nextSync = source.indexOf("\n  function ", start + 10);
  const ends = [next, nextSync].filter((n) => n > 0);
  return source.slice(start, Math.min(...ends));
}

test("page passes canWrite from the allowlist role", async () => {
  const page = await read("app/page.tsx");
  assert.ok(page.includes("canWrite={canWrite(access.role)}"));
  assert.match(page, /import \{[^}]*canWrite[^}]*\} from "\.\/lib\/users"/);
});

test("every write handler starts with a !canWrite early return", async () => {
  const app = await read("app/SchedulerApp.tsx");
  for (const name of ["submitBooking", "submitExtra", "saveClosure", "performDeleteClosure", "saveUnavailability", "performDeleteUnavailability", "moveCase", "saveDuration", "deleteCase"]) {
    const body = handlerBody(app, name);
    assert.match(body, /if \(!canWrite\)/, `${name} must guard on canWrite`);
    assert.match(body, /VIEWER_READ_ONLY_MESSAGE/, `${name} must report the viewer message`);
    assert.ok(body.indexOf("!canWrite") < body.indexOf("fetch("), `${name} guard must come before fetch`);
  }
  // The presence heartbeat stays unguarded.
  assert.doesNotMatch(handlerBody(app, "heartbeat"), /canWrite/);
});

test("write controls are hidden for viewers and a banner is shown", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.doesNotMatch(app, /const VIEWER_READ_ONLY_TEXT/);
  assert.match(app, /import \{ VIEWER_BANNER_TEXT, VIEWER_READ_ONLY_MESSAGE \} from "\.\/lib\/users"/);
  assert.match(app, /<strong>\{VIEWER_BANNER_TEXT\}<\/strong>/);
  const users = await read("app/lib/users.ts");
  assert.ok(users.includes('export const VIEWER_READ_ONLY_MESSAGE = "บัญชีนี้ดูตารางได้อย่างเดียว ไม่มีสิทธิ์แก้ไข"'));
  assert.ok(users.includes('export const VIEWER_BANNER_TEXT = "บัญชีนี้ดูตารางได้อย่างเดียว"'));
  const session = await read("app/lib/session.ts");
  assert.doesNotMatch(session, /VIEWER_READ_ONLY_MESSAGE = /);
  assert.match(session, /export \{ VIEWER_READ_ONLY_MESSAGE \}/);
  assert.match(app, /!canWrite && \(\s*<div className="setup-banner viewer-banner"/);
  assert.match(app, /\{canWrite && \(\s*<form onSubmit=\{submitBooking\}/);
  assert.match(app, /canWrite && scheduleView !== "closures" && <button className="text-button" type="button" onClick=\{\(\) => setShowExtra/);
  assert.match(app, /showExtra && canWrite &&/);
  assert.match(app, /\{canWrite && <form className="closure-form"/);
  assert.match(app, /\{canWrite && <form className="unavailability-form"/);
  assert.match(app, /\{canWrite && <div className="closure-row-actions">/);
  assert.match(app, /\{canWrite && <div className="unavailability-row-actions">/);
  assert.match(app, /selectedCase\?\.id === result\.id && canWrite && \(/);
  assert.match(app, /onManage=\{canWrite \? \(\) => manageFromDetail\(detailCase\) : undefined\}/);
  const dialog = await read("app/CaseDetailDialog.tsx");
  assert.match(dialog, /onManage\?: \(\) => void/);
  assert.match(dialog, /\{onManage && </);
});

test("user guide explains view-only accounts", async () => {
  assert.ok((await read("app/UserGuide.tsx")).includes("ดูอย่างเดียว"));
});

test("booking tab and desktop booking panel are hidden for viewers", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.ok(app.includes("resolveTab(searchParams.get(\"tab\"), canWrite)"));
  assert.ok(app.includes("<BottomNav active={activeTab} unseenAlerts={unseen} canWrite={canWrite}"));
  assert.match(app, /\{canWrite && <section className="panel booking-panel"/);
  const nav = await read("app/BottomNav.tsx");
  assert.ok(nav.includes("visibleTabs(canWrite).map("));
});
