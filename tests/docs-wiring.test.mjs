import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

test("runbook numbers are the real constants", async () => {
  const text = await read(RUNBOOK);
  assert.match(text, /20 นาที/);
  assert.match(text, /10–15 นาที/);
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
});
