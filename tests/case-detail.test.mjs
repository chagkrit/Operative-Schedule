import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("schedule API sends each case's duration (rows printed a dangling ' · ' without it)", async () => {
  const route = await read("app/api/schedule/route.ts");
  assert.match(route, /durationMinutes: booking\.durationMinutes,\n\s*calendarSyncStatus/);
});

test("tapping a case in the queue list or the month view opens its detail dialog", async () => {
  const app = await read("app/SchedulerApp.tsx");
  assert.match(app, /import CaseDetailDialog from "\.\/CaseDetailDialog"/);
  // Queue list rows and month-view rows are both tappable and keyboard-operable.
  assert.equal((app.match(/role="button" tabIndex=\{0\}/g) || []).length, 2);
  assert.match(app, /onOpenCase=\{openCaseDetail\}/);
  assert.match(app, /\{detailCase && \(\s*<CaseDetailDialog/);
  // The detail dialog is part of the shared modal machinery: Esc closes it, quiet refresh waits for it.
  assert.match(app, /setDetailCase\(null\);\s*if \(detailCase\) requestAnimationFrame\(\(\) => detailTriggerRef\.current\?\.focus\(\)\)/);
  assert.match(app, /dialogOpen: Boolean\([^)]*detailCase/);
});

test("detail dialog shows the full case and offers the existing move/delete flow", async () => {
  const dialog = await read("app/CaseDetailDialog.tsx");
  assert.match(dialog, /role="dialog" aria-modal="true" aria-labelledby="case-detail-title"/);
  for (const label of ["ผ่าตัด", "ผู้ป่วย", "HN", "Diagnosis", "Neoadjuvant", "Staff", "ระยะเวลา", "หมายเหตุ"]) {
    assert.ok(dialog.includes(`"${label}"`), `missing field ${label}`);
  }
  assert.match(dialog, /สลับวัน \/ แก้ไข \/ ลบ/);
  const app = await read("app/SchedulerApp.tsx");
  // The handoff runs a live search by HN, so a case changed on another device is shown as it is now.
  assert.match(app, /void searchCases\(undefined, \{ query: booking\.hn, selectId: booking\.id \}\)/);
  assert.match(app, /if \(searchId !== latestSearchRef\.current\) return;/);
});

test("case rows show a pointer and a visible keyboard focus ring", async () => {
  const css = await read("app/aurora.css");
  assert.match(css, /\.case-tap \{[^}]*cursor: pointer/);
  assert.match(css, /\.case-tap:focus-visible \{[^}]*outline:/);
});
