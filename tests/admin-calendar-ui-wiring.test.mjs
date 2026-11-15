import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "./ts-resolve.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const ui = await import("../app/admin/calendar-ui.ts");

const res = (status, body, { json = true } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => {
    if (!json) throw new SyntaxError("Unexpected token <");
    return body;
  },
});

// ---- pure helpers ----
test("readApiResponse parses JSON and flags non-JSON bodies (504/502 HTML, empty)", async () => {
  const ok = await ui.readApiResponse(res(200, { a: 1 }));
  assert.deepEqual({ status: ok.status, ok: ok.ok, body: ok.body, nonJson: ok.nonJson }, { status: 200, ok: true, body: { a: 1 }, nonJson: false });
  const html = await ui.readApiResponse(res(504, null, { json: false }));
  assert.equal(html.nonJson, true);
  assert.equal(html.body, null);
  const arr = await ui.readApiResponse(res(200, [1, 2]));
  assert.equal(arr.nonJson, true, "a non-object body is not an API payload");
});

test("parseApiError uses the server's fixed Thai error, else a status fallback, never throws", () => {
  assert.equal(ui.parseApiError({ status: 400, ok: false, nonJson: false, body: { error: "ข้อความจากเซิร์ฟเวอร์" } }), "ข้อความจากเซิร์ฟเวอร์");
  assert.equal(ui.parseApiError({ status: 401, ok: false, nonJson: false, body: {} }), "กรุณาเข้าสู่ระบบใหม่อีกครั้ง");
  assert.equal(ui.parseApiError({ status: 403, ok: false, nonJson: false, body: null }), "เฉพาะผู้ดูแลระบบเท่านั้น");
  assert.equal(ui.parseApiError({ status: 504, ok: false, nonJson: true, body: null }), ui.TIMEOUT_MESSAGE);
  assert.equal(ui.parseApiError({ status: 500, ok: false, nonJson: false, body: { error: 5 } }), "ทำรายการไม่สำเร็จ กรุณาลองใหม่");
});

test("describeSwitchOutcome: success, token renewal, resumable copy, switched-with-error, non-JSON, plain error", () => {
  const d = ui.describeSwitchOutcome;
  const copy = d({ status: 200, ok: true, nonJson: false, body: { mode: "copy", copied: 12, created: 12, updated: 0, unchanged: 0, counts: {}, skipped: 1, status: {} } });
  assert.equal(copy.kind, "success");
  assert.match(copy.text, /12/);

  const token = d({ status: 200, ok: true, nonJson: false, body: { mode: "token", status: {} } });
  assert.equal(token.kind, "success");

  const resumable = d({ status: 502, ok: false, nonJson: false, body: { error: "คัดลอกข้อมูลไปปฏิทินใหม่ไม่สำเร็จ ยังไม่ได้เปลี่ยนปฏิทิน กดเปลี่ยนอีกครั้งเพื่อคัดลอกต่อได้", step: "copy", switched: false } });
  assert.equal(resumable.kind, "error");
  assert.equal(resumable.resumable, true);
  assert.equal(resumable.hint, "กดสลับอีกครั้งเพื่อคัดลอกต่อ");
  assert.match(resumable.text, /กดเปลี่ยนอีกครั้ง/);

  const budget = d({ status: 502, ok: false, nonJson: false, body: { error: "คัดลอกยังไม่เสร็จในรอบเวลานี้ ยังไม่ได้เปลี่ยนปฏิทิน กดเปลี่ยนอีกครั้งเพื่อคัดลอกส่วนที่เหลือต่อ", step: "copy", switched: false } });
  assert.equal(budget.resumable, true);

  const copyHard = d({ status: 502, ok: false, nonJson: false, body: { error: "ข้อผิดพลาดอื่น", step: "copy", switched: false } });
  assert.equal(copyHard.resumable, false);
  assert.equal(copyHard.hint, undefined);

  const landed = d({ status: 500, ok: false, nonJson: false, body: { error: "เปลี่ยนปฏิทินหลักเป็นปฏิทินใหม่แล้ว แต่ระบบรายงานข้อผิดพลาด", step: "flip", switched: true } });
  assert.equal(landed.kind, "switched-with-error");
  assert.equal(landed.reload, true);

  const lockStep = d({ status: 409, ok: false, nonJson: false, body: { error: "ระบบกำลังเปลี่ยนปฏิทิน กรุณาลองใหม่ในอีกสักครู่", step: "lock", switched: false } });
  assert.equal(lockStep.kind, "error");
  assert.equal(lockStep.resumable, false);

  const html = d({ status: 504, ok: false, nonJson: true, body: null });
  assert.equal(html.kind, "unknown");
  assert.equal(html.reload, true);
  assert.equal(html.text, ui.TIMEOUT_MESSAGE);
  assert.match(ui.TIMEOUT_MESSAGE, /ตรวจสถานะแล้วกดสลับอีกครั้งเพื่อทำต่อ/);

  const plain = d({ status: 409, ok: false, nonJson: false, body: { error: "ยังไม่ได้เชื่อมต่อปฏิทินใหม่" } });
  assert.equal(plain.kind, "error");
  assert.equal(plain.text, "ยังไม่ได้เชื่อมต่อปฏิทินใหม่");
});

test("reconcileAfterSwitch decides success / locked / not-switched from the reloaded status", () => {
  const cand = { email: "new@x.com", calendarId: "cal-new" };
  const base = { master: { email: "old@x.com", calendarId: "cal-old", source: "settings" }, candidate: cand, locked: false, keyConfigured: true };
  assert.equal(ui.reconcileAfterSwitch(cand, { ...base, master: { ...cand, source: "settings" } }), "switched");
  assert.equal(ui.reconcileAfterSwitch(cand, { ...base, master: { email: "NEW@x.com", calendarId: "CAL-NEW", source: "settings" } }), "switched");
  assert.equal(ui.reconcileAfterSwitch(cand, { ...base, locked: true }), "locked");
  assert.equal(ui.reconcileAfterSwitch(cand, base), "not-switched");
  assert.equal(ui.reconcileAfterSwitch(cand, null), "unknown");
});

test("isFreshLock: only a numeric lockedSince under 60 s old counts", () => {
  const now = 10_000_000;
  assert.equal(ui.isFreshLock({ locked: true, lockedSince: now - 59_999 }, now), true);
  assert.equal(ui.isFreshLock({ locked: true, lockedSince: now - 60_000 }, now), false);
  assert.equal(ui.isFreshLock({ locked: true }, now), true, "locked with unknown age is treated as fresh (safe side)");
  assert.equal(ui.isFreshLock({ locked: false, lockedSince: now - 1 }, now), false);
});

// ---- source wiring ----
const COMPONENT = await read("app/admin/AdminCalendar.tsx");
const PAGE = await read("app/admin/page.tsx");

test("page.tsx renders AdminCalendar inside the admin-gated page with a token-free initial status", () => {
  assert.match(PAGE, /import AdminCalendar from "\.\/AdminCalendar"/);
  assert.match(PAGE, /<AdminCalendar initial=\{/);
  assert.ok(PAGE.indexOf('role !== "admin"') < PAGE.indexOf("<AdminCalendar"), "admin gate comes before the render");
  assert.match(PAGE, /buildStatus\(/, "the server-side status builder is reused (public fields only)");
  assert.doesNotMatch(PAGE, /sealedRefreshToken|GOOGLE_REFRESH_TOKEN/, "no token field is read by the page");
});

test("AdminCalendar talks to /api/admin/calendar with the four actions and GET reload", () => {
  assert.match(COMPONENT, /^"use client";/);
  assert.match(COMPONENT, /"\/api\/admin\/calendar"/);
  for (const a of ["connect", "preview", "switch", "clearLock"]) assert.match(COMPONENT, new RegExp(`"${a}"`), a);
  assert.match(COMPONENT, /body \? "POST" : "GET"/);
  assert.match(COMPONENT, /cache: "no-store"/);
  assert.match(COMPONENT, /readApiResponse\(/);
  assert.match(COMPONENT, /describeSwitchOutcome\(/);
  assert.match(COMPONENT, /reconcileAfterSwitch\(/);
});

test("token field is a password input, autoComplete off, cleared after every submit, never stored in state or rendered", () => {
  assert.match(COMPONENT, /type="password"/);
  assert.match(COMPONENT, /autoComplete="off"/);
  assert.doesNotMatch(COMPONENT, /useState[^\n]*[Tt]oken/, "no token state");
  assert.doesNotMatch(COMPONENT, /\{[^}]*refreshToken[^}]*\}<\/|value=\{[^}]*[Tt]oken/, "token never rendered back");
  assert.doesNotMatch(COMPONENT, /console\./);
  // the field is read then cleared before the request is awaited
  const submit = COMPONENT.slice(COMPONENT.indexOf("async function connect"));
  assert.ok(submit.indexOf('.value = ""') !== -1 && submit.indexOf('.value = ""') < submit.indexOf("await "), "cleared before the network call");
});

test("confirm dialog states the write freeze, untouched old calendar, and app-only editing; clear-lock warns", () => {
  assert.match(COMPONENT, /role="dialog"/);
  assert.match(COMPONENT, /aria-modal="true"/);
  assert.match(COMPONENT, /Escape/);
  assert.match(COMPONENT, /10.15 นาที/);
  assert.match(COMPONENT, /ปฏิทินเดิมจะไม่ถูกแก้ไข/);
  assert.match(COMPONENT, /ปฏิทินก่อนหน้า/);
  assert.match(COMPONENT, /ห้ามแก้ไขใน Google Calendar โดยตรง/);
  assert.match(COMPONENT, /ตัดการสลับที่กำลังทำงานอยู่ให้ขาดกลางคัน/);
  assert.match(COMPONENT, /isFreshLock\(/);
  assert.match(COMPONENT, /ปลดล็อก/);
  assert.match(COMPONENT, /กำลังคัดลอก… \(ใช้เวลาได้หลายนาที ห้ามปิดหน้านี้\)/);
  assert.match(COMPONENT, /กดสลับอีกครั้งเพื่อคัดลอกต่อ|hint/);
  assert.match(COMPONENT, /role="status"/);
  assert.match(COMPONENT, /ตั้งต้นจาก env/);
  assert.match(COMPONENT, /ปฏิทินปลายทางไม่ว่าง/);
});

test("busy guard: a synchronous ref blocks double submits and every action is disabled while busy", () => {
  assert.match(COMPONENT, /busyRef/);
  assert.match(COMPONENT, /if \(busyRef\.current\) return/);
  assert.ok((COMPONENT.match(/disabled=\{isBusy/g) || []).length >= 6);
});

test("no color literals in the component or the admin-calendar CSS", async () => {
  const css = await read("app/globals.css");
  const block = css.slice(css.indexOf("/* Admin: master calendar"));
  assert.ok(block.length > 100, "css block exists");
  for (const text of [COMPONENT, block]) assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
});

test("UserGuide carries the edit-through-the-app notice", async () => {
  const guide = await read("app/UserGuide.tsx");
  assert.match(guide, /ห้ามเพิ่ม\/ลากเคสในปฏิทิน Google โดยตรง แก้ผ่านแอปเท่านั้น/);
});
