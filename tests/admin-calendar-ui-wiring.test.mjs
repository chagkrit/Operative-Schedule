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

// ---- fix round 1: classification + decideAfterSwitch ----
test("describeSwitchOutcome classifies network failure, JSON outcome-unknown and flip-without-switched as unknown", () => {
  const d = ui.describeSwitchOutcome;
  const net = d({ status: 0, ok: false, nonJson: false, body: { error: ui.NETWORK_MESSAGE } });
  assert.equal(net.kind, "unknown");
  assert.equal(net.reload, true);
  assert.equal(net.resumable, false);
  const jsonUnknown = d({ status: 500, ok: false, nonJson: false, body: { error: "ไม่ทราบผลการเปลี่ยนปฏิทินหลัก กรุณาเปิดหน้าสถานะเพื่อตรวจก่อนทำรายการต่อ", step: "flip" } });
  assert.equal(jsonUnknown.kind, "unknown");
  const flipNoSwitched = d({ status: 500, ok: false, nonJson: false, body: { error: "ข้อความอื่น", step: "flip" } });
  assert.equal(flipNoSwitched.kind, "unknown");
  const flipKnown = d({ status: 500, ok: false, nonJson: false, body: { error: "ข้อความอื่น", step: "flip", switched: false } });
  assert.equal(flipKnown.kind, "error");
  const html504 = d({ status: 504, ok: false, nonJson: true, body: null });
  assert.equal(html504.kind, "unknown");
  const plain400 = d({ status: 400, ok: false, nonJson: false, body: { error: "ข้อมูลไม่ถูกต้อง" } });
  assert.equal(plain400.kind, "error");
  assert.equal(plain400.resumable, false);
});

const FORMER = { email: "new@x.com", calendarId: "cal-new" };
const OLD = { email: "old@x.com", calendarId: "cal-old", source: "settings" };
const st = (o = {}) => ({ master: OLD, candidate: FORMER, locked: false, keyConfigured: true, ...o });
const out = (body, status = 502, nonJson = false) => ui.describeSwitchOutcome({ status, ok: status < 300, nonJson, body });
const RESUMABLE = out({ error: "คัดลอกยังไม่เสร็จ ยังไม่ได้เปลี่ยนปฏิทิน กดเปลี่ยนอีกครั้งเพื่อคัดลอกส่วนที่เหลือต่อ", step: "copy", switched: false });

test("decideAfterSwitch: landed clears the preview with a success notice", () => {
  const ok = out({ mode: "copy", copied: 3 }, 200);
  const r = ui.decideAfterSwitch(ok, st({ master: { ...FORMER, source: "settings" }, candidate: undefined }), FORMER);
  assert.equal(r.keepPreview, false);
  assert.equal(r.notice.type, "success");
  const viaTimeout = ui.decideAfterSwitch(out(null, 504, true), st({ master: { ...FORMER, source: "settings" }, candidate: undefined }), FORMER);
  assert.equal(viaTimeout.keepPreview, false);
  assert.equal(viaTimeout.notice.type, "success");
});

test("decideAfterSwitch: resumable copy error keeps the preview, button stays enabled, hint shown", () => {
  const fresh = st();
  const r = ui.decideAfterSwitch(RESUMABLE, fresh, FORMER);
  assert.equal(r.keepPreview, true);
  assert.equal(r.notice.type, "error");
  assert.equal(r.notice.hint, "กดสลับอีกครั้งเพื่อคัดลอกต่อ");
  assert.equal(ui.canSwitchNow(fresh, { tokenOnly: false }), true);
});

test("decideAfterSwitch: not-switched after unknown keeps preview; candidate changed clears it", () => {
  const unknown = out(null, 504, true);
  const keep = ui.decideAfterSwitch(unknown, st(), FORMER);
  assert.equal(keep.keepPreview, true);
  assert.ok(keep.notice.hint);
  const changed = ui.decideAfterSwitch(RESUMABLE, st({ candidate: { email: "other@x.com", calendarId: "other" } }), FORMER);
  assert.equal(changed.keepPreview, false);
  const gone = ui.decideAfterSwitch(RESUMABLE, st({ candidate: undefined }), FORMER);
  assert.equal(gone.keepPreview, false);
});

test("decideAfterSwitch: locked never offers 'press again'; reload failure keeps preview with status-unknown notice", () => {
  const net = out({ error: ui.NETWORK_MESSAGE }, 0);
  const locked = ui.decideAfterSwitch(net, st({ locked: true, lockedSince: 1 }), FORMER);
  assert.equal(locked.keepPreview, true);
  assert.equal(locked.notice.hint, undefined);
  assert.match(locked.notice.text, /การสลับอาจยังทำงานอยู่/);
  assert.doesNotMatch(JSON.stringify(locked.notice), /กดสลับอีกครั้ง/);
  const lockedResumable = ui.decideAfterSwitch(RESUMABLE, st({ locked: true }), FORMER);
  assert.doesNotMatch(JSON.stringify(lockedResumable.notice), /กดสลับอีกครั้ง/);
  assert.equal(ui.canSwitchNow(st({ locked: true }), { tokenOnly: false }), false);
  const failed = ui.decideAfterSwitch(net, null, FORMER);
  assert.equal(failed.keepPreview, true);
  assert.equal(failed.notice.type, "error");
  assert.match(failed.notice.text, /โหลดสถานะใหม่/);
  assert.equal(ui.canSwitchNow(st(), { tokenOnly: false }), true);
});

// ---- fix round 2: landed = candidate gone/changed, never "master equals candidate" ----
const TOKEN_ONLY_STATUS = (o = {}) => st({ master: { ...FORMER, source: "settings" }, candidate: FORMER, ...o });
const errOut = (body, status) => out(body, status);

test("token-only failures (master==candidate before and after) are never success", () => {
  const cases = [
    errOut({ error: "มีการแก้ไขการตั้งค่าปฏิทินพร้อมกัน กรุณาลองใหม่" }, 409),
    errOut({ error: "บันทึกการตั้งค่าปฏิทินไม่สำเร็จ กรุณาลองใหม่" }, 500),
    out({ error: ui.NETWORK_MESSAGE }, 0),
    out(null, 504, true),
  ];
  for (const outcome of cases) {
    const r = ui.decideAfterSwitch(outcome, TOKEN_ONLY_STATUS(), FORMER);
    assert.equal(r.notice.type, "error", outcome.text);
    assert.equal(r.keepPreview, true);
    assert.ok(ui.canSwitchNow(TOKEN_ONLY_STATUS(), { tokenOnly: true }));
  }
  const conc = ui.decideAfterSwitch(cases[0], TOKEN_ONLY_STATUS(), FORMER);
  assert.match(conc.notice.text, /พร้อมกัน/);
});

test("409 LOCKED with a locked fresh status shows the lock, not success", () => {
  const lockedOut = errOut({ error: "ระบบกำลังเปลี่ยนปฏิทิน กรุณาลองใหม่ในอีกสักครู่" }, 409);
  const r = ui.decideAfterSwitch(lockedOut, TOKEN_ONLY_STATUS({ locked: true, lockedSince: 1 }), FORMER);
  assert.equal(r.notice.type, "error");
  assert.equal(r.notice.text, ui.LOCKED_NOW_MESSAGE);
  assert.equal(r.keepPreview, true);
  // even if the candidate is gone, a live lock is shown first
  const r2 = ui.decideAfterSwitch(out(null, 504, true), st({ candidate: undefined, locked: true, lockedSince: 1 }), FORMER);
  assert.equal(r2.notice.type, "error");
  assert.doesNotMatch(JSON.stringify(r2.notice), /กดสลับอีกครั้ง/);
});

test("token-only success and normal copy success (candidate gone after reload) clear the preview", () => {
  const tokenOk = ui.decideAfterSwitch(out({ mode: "token", status: {} }, 200), TOKEN_ONLY_STATUS({ candidate: undefined }), FORMER);
  assert.equal(tokenOk.notice.type, "success");
  assert.equal(tokenOk.keepPreview, false);
  const copyOk = ui.decideAfterSwitch(out({ mode: "copy", copied: 2 }, 200), st({ master: { ...FORMER, source: "settings" }, candidate: undefined }), FORMER);
  assert.equal(copyOk.notice.type, "success");
  assert.equal(copyOk.keepPreview, false);
});

test("definite errors never become success; candidate unchanged keeps preview, candidate changed clears it", () => {
  const keep = ui.decideAfterSwitch(RESUMABLE, st(), FORMER);
  assert.equal(keep.notice.type, "error");
  assert.equal(keep.keepPreview, true);
  const flipFalse = out({ error: "x", step: "flip", switched: false }, 500);
  const gone = ui.decideAfterSwitch(flipFalse, st({ candidate: undefined }), FORMER);
  assert.equal(gone.notice.type, "error");
  assert.equal(gone.keepPreview, false);
  const changed = ui.decideAfterSwitch(RESUMABLE, st({ candidate: { email: "other@x.com", calendarId: "o" } }), FORMER);
  assert.equal(changed.notice.type, "error");
  assert.equal(changed.keepPreview, false);
});

// ---- fix round 3: unknown + candidate changed needs master/previousMaster evidence ----
const OTHER = { email: "other@x.com", calendarId: "other-cal" };

test("unknown outcome + unlocked + candidate changed + master unchanged is NOT success", () => {
  const flipUnknown = out({ error: "ไม่ทราบผลการเปลี่ยนปฏิทินหลัก กรุณาเปิดหน้าสถานะ", step: "flip" }, 500);
  for (const outcome of [out(null, 504, true), out({ error: ui.NETWORK_MESSAGE }, 0), flipUnknown]) {
    assert.equal(outcome.kind, "unknown");
    const r = ui.decideAfterSwitch(outcome, st({ candidate: OTHER }), FORMER);
    assert.equal(r.notice.type, "error");
    assert.equal(r.keepPreview, false);
    assert.equal(r.notice.hint, undefined);
    assert.match(r.notice.text, /สถานะล่าสุด/);
  }
});

test("candidate changed but previousMaster equals former (ours landed, someone switched again) is landed", () => {
  const r = ui.decideAfterSwitch(out(null, 504, true), st({ candidate: OTHER, previousMaster: { ...FORMER } }), FORMER);
  assert.equal(r.notice.type, "success");
  assert.equal(r.keepPreview, false);
});

test("switched-with-error + candidate changed is landed; master equal to former is landed", () => {
  const swe = out({ error: "เปลี่ยนแล้วแต่มีข้อผิดพลาด", step: "flip", switched: true }, 500);
  assert.equal(swe.kind, "switched-with-error");
  const r = ui.decideAfterSwitch(swe, st({ candidate: OTHER }), FORMER);
  assert.equal(r.notice.type, "success");
  const m = ui.decideAfterSwitch(out(null, 504, true), st({ master: { ...FORMER, source: "settings" }, candidate: OTHER }), FORMER);
  assert.equal(m.notice.type, "success");
});

test("locked + candidate gone or changed does not keep a stale preview", () => {
  const net = out({ error: ui.NETWORK_MESSAGE }, 0);
  assert.equal(ui.decideAfterSwitch(net, st({ locked: true, candidate: undefined }), FORMER).keepPreview, false);
  assert.equal(ui.decideAfterSwitch(net, st({ locked: true, candidate: OTHER }), FORMER).keepPreview, false);
  assert.equal(ui.decideAfterSwitch(net, st({ locked: true }), FORMER).keepPreview, true);
});

// ---- preview diagnostics view ----
test("parseDiagnostics tolerates missing or malformed diagnostics and clamps to numbers", () => {
  for (const bad of [undefined, null, 5, "x", [], {}]) assert.equal(ui.parseDiagnostics(bad), null, String(bad));
  const d = ui.parseDiagnostics({
    invalidIds: { reasons: { uppercase: 2, hyphen: "x" }, shapes: [{ shape: "Aa-9", count: 2 }, { shape: 5 }, null], byKind: { app: 1 } },
    recurring: { masters: 3, byFreq: { WEEKLY: 2 } },
    skippedReasons: { cancelled: 4 },
  });
  assert.equal(d.shapesOmitted, 0);
  const capped = ui.parseDiagnostics({ invalidIds: { shapes: [{ shape: "x".repeat(200), count: 1 }, { shape: "\u{1F600}".repeat(60), count: 1 }], shapesOmitted: 3 } });
  assert.equal(Array.from(capped.shapes[0].shape).length, 49);
  assert.equal(Array.from(capped.shapes[1].shape).length, 49);
  assert.equal(capped.shapesOmitted, 3);
  assert.equal(d.reasons.uppercase, 2);
  assert.equal(d.reasons.hyphen, 0);
  assert.equal(d.reasons.tooShort, 0);
  assert.deepEqual(d.shapes, [{ shape: "Aa-9", count: 2 }]);
  assert.equal(d.byKind.app, 1);
  assert.equal(d.byKind.legacy, 0);
  assert.equal(d.recurring.masters, 3);
  assert.equal(d.recurring.byFreq.WEEKLY, 2);
  assert.equal(d.recurring.byFreq.DAILY, 0);
  assert.equal(d.skippedReasons.cancelled, 4);
  assert.equal(d.skippedReasons.notReadable, 0);
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
  assert.match(COMPONENT, /decideAfterSwitch\(/);
  assert.match(COMPONENT, /canSwitchNow\(/);
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

// ---- final fix wave: preview blockers (rollback rule, event ids) --------------------------------
test("switchBlockReason: target conflicts and a plan refusal block the switch; remapped ids (invalidIds) no longer do", () => {
  assert.equal(ui.switchBlockReason(null), null);
  assert.equal(ui.switchBlockReason({ tokenOnly: false }), null);
  assert.equal(ui.switchBlockReason({ tokenOnly: false, targetConflicts: 0, invalidIds: 0 }), null);
  assert.equal(ui.switchBlockReason({ tokenOnly: true, targetConflicts: 0, invalidIds: 0 }), null);
  const conflicts = ui.switchBlockReason({ tokenOnly: false, targetConflicts: 3, invalidIds: 0 });
  assert.match(conflicts, /3 รายการ/);
  assert.match(conflicts, /ยกเลิกหรือลบ/); // the current master no longer has them (cancelled/deleted since)
  assert.match(conflicts, /ปฏิทินใหม่ที่ว่าง/); // the safe way: a NEW, EMPTY calendar
  assert.match(conflicts, /ห้ามสลับ/);
  // step 2: ids Google rejects are copied under new ids, so they never block
  assert.equal(ui.switchBlockReason({ tokenOnly: false, targetConflicts: 0, invalidIds: 17 }), null);
  // a plan refusal (fixed Thai text from the server) blocks and is shown as is
  const refusal = "SYNTH-REFUSAL ยังไม่ได้เปลี่ยนปฏิทิน";
  assert.equal(ui.switchBlockReason({ tokenOnly: false, targetConflicts: 0, planBlocked: refusal }), refusal);
  assert.equal(ui.switchBlockReason({ tokenOnly: false, targetConflicts: 0, planBlocked: "" }), null);
  assert.equal(ui.switchBlockReason({ tokenOnly: false, targetConflicts: 0, planBlocked: 5 }), null);
  const both = ui.switchBlockReason({ tokenOnly: false, targetConflicts: 1, planBlocked: refusal });
  assert.ok(both.includes(conflicts.replace("3 รายการ", "1 รายการ")) && both.includes(refusal));
});

test("canSwitchNow is false while the preview shows target conflicts or a plan refusal; remapped ids do not block", () => {
  const status = { master: { email: "a@x.com", calendarId: "a", source: "settings" }, candidate: { email: "b@x.com", calendarId: "b" }, locked: false, keyConfigured: true };
  assert.equal(ui.canSwitchNow(status, { tokenOnly: false, targetConflicts: 0, invalidIds: 0 }), true);
  assert.equal(ui.canSwitchNow(status, { tokenOnly: false, targetConflicts: 1, invalidIds: 0 }), false);
  assert.equal(ui.canSwitchNow(status, { tokenOnly: false, targetConflicts: 0, invalidIds: 4 }), true);
  assert.equal(ui.canSwitchNow(status, { tokenOnly: false, targetConflicts: 0, planBlocked: "x" }), false);
});

test("AdminCalendar shows targetConflicts, remapped ids (non-blocking), exceptions and the block reason; a preflight refusal drops the stale preview", () => {
  assert.match(COMPONENT, /targetConflicts: number;/);
  assert.match(COMPONENT, /invalidIds: number;/);
  assert.match(COMPONENT, /targetConflicts: num\(body\.targetConflicts\)/);
  assert.match(COMPONENT, /invalidIds: num\(body\.invalidIds\)/);
  assert.match(COMPONENT, /switchBlockReason\(preview\)/);
  assert.match(COMPONENT, /preview\.targetConflicts/);
  assert.match(COMPONENT, /preview\.invalidIds/);
  assert.match(COMPONENT, /step === "preflight"/);
  assert.match(COMPONENT, /รหัส event ที่ต้องออกรหัสใหม่ \(ไม่บล็อก\)/);
  assert.doesNotMatch(COMPONENT, /รหัส event ที่คัดลอกไม่ได้/);
  assert.match(COMPONENT, /planBlocked/);
  assert.match(COMPONENT, /preview\.exceptions\.modify/);
  assert.match(COMPONENT, /preview\.exceptions\.cancel/);
  assert.match(COMPONENT, /รายการยกเว้นของรายการซ้ำที่จะคัดลอก/);
});

test("AdminCalendar renders diagnostics in a closed <details> via parseDiagnostics, with tokens only", () => {
  assert.match(COMPONENT, /parseDiagnostics/);
  assert.match(COMPONENT, /<details className="admin-calendar-diagnostics">/);
  assert.match(COMPONENT, /รายละเอียดสำหรับนักพัฒนา/);
  assert.doesNotMatch(COMPONENT, /<details[^>]* open/);
  const block = COMPONENT.slice(COMPONENT.indexOf("admin-calendar-diagnostics"));
  assert.doesNotMatch(block.slice(0, 4000), /#[0-9a-fA-F]{3,8}\b|rgba?\(/, "no colour literals");
});
