import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "./ts-resolve.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const RUNBOOK = "docs/owner-pack/calendar-switch-RUNBOOK.md";

test("runbook names the key, the token script with --email, preview, freeze, rollback and the edit-only-through-app rule", async () => {
  const text = await read(RUNBOOK);
  for (const needle of [
    "CALENDAR_SETTINGS_KEY",
    "openssl rand -base64 32",
    "scripts/get-calendar-refresh-token.mjs",
    "--email",
    "ตรวจตัวอย่างก่อนสลับ",
    "หยุดการบันทึก",
    "ปลดล็อก",
    "Rollback",
    "ห้ามแก้ในปฏิทินโดยตรง",
    "GOOGLE_REFRESH_TOKEN",
    "calendar.events",
  ]) {
    assert.ok(text.includes(needle), `runbook is missing: ${needle}`);
  }
});

const sw = await import("../app/lib/calendar-switch.ts");
const { SETTINGS_CACHE_TTL_MS } = await import("../app/lib/calendar-settings-store.ts");
const { CALENDAR_WRITE_DEADLINE_MS, CALENDAR_SETTINGS_UNREADABLE_MESSAGE } = await import("../app/lib/calendar-target.ts");
const { LOCK_TTL_MS } = await import("../app/lib/calendar-settings.ts");
const sec = (ms) => `${ms / 1000} วินาที`;

test("runbook numbers are the real constants", async () => {
  const text = await read(RUNBOOK);
  assert.ok(text.includes(`${LOCK_TTL_MS / 60_000} นาที`), "lock TTL");
  assert.match(text, /10–15 นาที/);
  // per-press timing: copy budget + settle + hold, and the hard deadline
  for (const ms of [sw.COPY_PHASE_BUDGET_MS, sw.SETTLE_MS, sw.LOCK_HOLD_AFTER_FLIP_MS, sw.RUN_HARD_DEADLINE_MS]) {
    assert.ok(text.includes(sec(ms)), `runbook is missing ${sec(ms)}`);
  }
  // day-one deltas: cache TTL for reads and the write deadline
  assert.ok(text.includes(sec(SETTINGS_CACHE_TTL_MS)), "settings cache TTL");
  assert.ok(text.includes(sec(CALENDAR_WRITE_DEADLINE_MS)), "write deadline");
});

test("runbook: rollback = switch into a NEW, EMPTY calendar; the old populated one is blocked; blob delete is lossy", async () => {
  const text = await read(RUNBOOK);
  const rollback = text.slice(text.indexOf("## Rollback"), text.indexOf("\n## ", text.indexOf("## Rollback") + 5));
  assert.ok(rollback.length > 200, "rollback section exists");
  for (const needle of [
    "ปฏิทินใหม่ที่ว่าง", // switch back into a NEW, EMPTY calendar
    "ห้ามสลับกลับไปปฏิทินเดิม", // never into the old populated one after anything was deleted
    "ปฏิทินปลายทางไม่ว่าง", // the preview warning is expected for the old calendar and means don't switch there
    "หน้าจอจะไม่ให้กดสลับ", // the screen now blocks it
    "ปฏิทินก่อนหน้า", // where to find the previous calendar id
    "กลับมาเป็นคิวที่ยังจองอยู่", // blob delete: cancelled cases reappear as booked
    "หายไป", // ... and newer events are lost
  ]) {
    assert.ok(rollback.includes(needle), `rollback section is missing: ${needle}`);
  }
  // a resumed press can hit the same block when a source event was deleted between presses
  assert.ok(text.includes("ระหว่างรอบ"), "resume caveat");
});

test("runbook: never code-rollback after the first switch without switching back to the env calendar; keep GOOGLE_REFRESH_TOKEN", async () => {
  const text = await read(RUNBOOK);
  assert.ok(text.includes("promote"), "names promoting an older deployment");
  assert.ok(text.includes("ข้อมูลแยกเป็นสองที่"), "states the silent split");
  assert.ok(text.includes("ห้ามลบ `GOOGLE_REFRESH_TOKEN`"), "keep GOOGLE_REFRESH_TOKEN set");
  assert.ok(text.includes("auth.ts"), "explains the sign-in dependency");
  assert.ok(text.includes("viewer"), "viewer-role warning stays");
  // token-only renewal in env mode also moves the master into the settings file
  assert.ok(text.includes("ต่ออายุ token อย่างเดียวในโหมด env"), "env-mode renewal moves the master");
});

test("runbook: day-one changes of deploying this release, Blob usage check, Preview/Development key", async () => {
  const text = await read(RUNBOOK);
  for (const needle of [
    "ตั้งแต่ deploy รุ่นนี้", // even before any switch
    "อ่าน Blob ใหม่ 1 ครั้ง", // every write = one fresh Blob read
    "ประมาณสองเท่า", // about double the Blob reads
    CALENDAR_SETTINGS_UNREADABLE_MESSAGE.split(" ")[0], // Blob outage => 503 with this message
    "nansurg7@gmail.com", // the break-glass admin also loses the schedule during a Blob outage
    "Storage → Blob", // owner check before merge
    "Hobby",
    "Preview",
    "Development",
  ]) {
    assert.ok(text.includes(needle), `runbook is missing: ${needle}`);
  }
});

test("runbook: token script prerequisites, calendar id location, write vs read access, deploy first, key-loss recovery", async () => {
  const text = await read(RUNBOOK);
  const script = await read("scripts/get-calendar-refresh-token.mjs");
  // the facts the runbook states must still be true of the script
  assert.match(script, /const PORT = 3000;/);
  assert.match(script, /http:\/\/localhost:\$\{PORT\}\/api\/auth\/callback\/google/);
  assert.match(script, /Signed in as \$\{info\.email\}, expected \$\{AUTHORIZED_EMAIL\}/);
  for (const needle of [
    "node --env-file=.env.local",
    "AUTH_GOOGLE_ID",
    "AUTH_GOOGLE_SECRET",
    "http://localhost:3000/api/auth/callback/google",
    "พอร์ต 3000",
    "In production",
    "Signed in as",
    "ยังไม่ได้ยืนยัน", // the "unverified app" screen for non-owner accounts is unverified
    "Integrate calendar", // where the calendar id is
    "Calendar ID",
    "สิทธิ์เขียน", // write access suffices ...
    "ตรวจแค่สิทธิ์อ่าน", // ... but connect checks only read access
    "merge และ deploy", // merge + deploy before step 1
    "คีย์หาย", // key-loss recovery via the token-only path
  ]) {
    assert.ok(text.includes(needle), `runbook is missing: ${needle}`);
  }
});

test("README: break-glass admin loses the schedule during a Blob outage; GOOGLE_REFRESH_TOKEN stays set", async () => {
  const text = await read("README.md");
  assert.ok(text.includes("ตารางคิว") && text.includes("Blob ขัดข้อง"), "break-glass caveat");
  assert.match(text, /ดูหรือแก้ตารางคิวไม่ได้/);
  assert.ok(text.includes("ห้ามลบ `GOOGLE_REFRESH_TOKEN`"));
  assert.ok(text.includes("promote"), "code-rollback warning");
});

test("runbook and docs contain no token-like secrets", async () => {
  for (const path of [RUNBOOK, "README.md", "GLOSSARY.md", ".env.example"]) {
    const text = await read(path);
    assert.doesNotMatch(text, /1\/\/[A-Za-z0-9_-]{20,}/, `${path} has a refresh-token-like string`);
    assert.doesNotMatch(text, /GOCSPX-/, `${path} has a client-secret-like string`);
  }
});

test(".env.example lists CALENDAR_SETTINGS_KEY with no value", async () => {
  const text = await read(".env.example");
  assert.match(text, /^CALENDAR_SETTINGS_KEY=$/m);
});

test("README documents the master switch and the renewal change after the first switch", async () => {
  const text = await read("README.md");
  assert.ok(text.includes("ปฏิทินหลัก"));
  assert.ok(text.includes("calendar-switch-RUNBOOK.md"));
  assert.ok(text.includes("CALENDAR_SETTINGS_KEY"));
  assert.match(text, /หลังสลับครั้งแรก/);
});

test("GLOSSARY defines ปฏิทินหลัก as a definition only", async () => {
  const text = await read("GLOSSARY.md");
  const match = text.match(/\*\*ปฏิทินหลัก\*\*:\n([^\n]+)\n_Avoid_:/);
  assert.ok(match, "ปฏิทินหลัก entry with an _Avoid_ line is missing");
  for (const impl of ["token", "Blob", "CALENDAR_SETTINGS_KEY", "GOOGLE_", "settings", "นาที"]) {
    assert.ok(!match[1].includes(impl), `definition must not mention implementation detail: ${impl}`);
  }
  assert.ok(match[1].includes("วัน OR Extra"), "OR Extra days are among the stored items");
});

test("runbook + README (step 2): remapped ids are handled automatically (not a stop signal); recurring exceptions are copied", async () => {
  const runbook = await read(RUNBOOK);
  const readme = await read("README.md");
  for (const text of [runbook, readme]) {
    assert.ok(!text.includes("รหัส event ที่คัดลอกไม่ได้"), "old blocking label is gone");
    assert.ok(!text.includes("การสลับจะยังถูกบล็อกจนกว่าผู้พัฒนาจะแก้ให้"), "old stop-and-contact guidance is gone");
    assert.ok(text.includes("orig_id"), "remapped events keep the old id in orig_id");
    assert.ok(text.includes("รายการยกเว้น"), "recurring exceptions are mentioned");
  }
  assert.ok(runbook.includes("รหัส event ที่ต้องออกรหัสใหม่ (ไม่บล็อก)"), "the new preview label");
  assert.ok(runbook.includes("สัญญาณที่ห้ามสลับ"), "stop signals still listed");
  // the stop signals are now conflicts + a plan refusal shown by the screen, not remapped ids
  const signals = runbook.slice(runbook.indexOf("สัญญาณที่ห้ามสลับ"), runbook.indexOf("\n", runbook.indexOf("สัญญาณที่ห้ามสลับ")));
  assert.ok(!signals.includes("ออกรหัสใหม่"), "remapped ids are not a stop signal");
});
