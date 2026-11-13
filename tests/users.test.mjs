import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOTSTRAP_ADMIN,
  SEED_USERS,
  addUser,
  findAccess,
  isValidEmail,
  normalizeEmail,
  removeUser,
  setActive,
  setRole,
  withBootstrap,
} from "../app/lib/users.ts";

const u = (email, role = "user", active = true) => ({ email, role, active });
const ADMIN = BOOTSTRAP_ADMIN;
const HN = "hnbcmu@gmail.com";

// Deep-frozen copy so any in-place mutation throws.
function frozen(list) {
  return Object.freeze(list.map((r) => Object.freeze({ ...r })));
}

function expectError(result, pattern) {
  assert.equal(result.ok, false, `expected rejection, got ${JSON.stringify(result)}`);
  assert.match(result.error, pattern);
}

test("bootstrap admin and seed list", () => {
  assert.equal(BOOTSTRAP_ADMIN, "nansurg7@gmail.com");
  assert.deepEqual(SEED_USERS, [u("nansurg7@gmail.com", "admin"), u("hnbcmu@gmail.com", "user")]);
});

test("normalizeEmail trims and lower-cases", () => {
  assert.equal(normalizeEmail("  HnBcMu@GMAIL.com \n"), "hnbcmu@gmail.com");
  assert.equal(normalizeEmail(""), "");
});

test("isValidEmail accepts any domain with a valid format", () => {
  for (const ok of ["a@x.com", "hnbcmu@gmail.com", "someone@cmu.ac.th", "first.last+tag@sub.example.org", "  A@X.COM "]) {
    assert.equal(isValidEmail(ok), true, ok);
  }
  for (const bad of ["", "abc", "a@b", "a b@x.com", "a@@x.com", "a@b@x.com", "@x.com", "a@.com", "a@x.", "a@x..com", "a@x .com", "a@-x.com"]) {
    assert.equal(isValidEmail(bad), false, bad);
  }
});

test("withBootstrap forces bootstrap admin active, dedupes case-insensitively, keeps order", () => {
  assert.deepEqual(withBootstrap([]), [u(ADMIN, "admin")]);
  const input = frozen([u("B@x.com", "user", false), u("nansurg7@GMAIL.com", "user", false), u("b@x.com", "admin")]);
  assert.deepEqual(withBootstrap(input), [u("b@x.com", "user", false), u(ADMIN, "admin")]);
  assert.deepEqual(withBootstrap(frozen([u(HN)])), [u(ADMIN, "admin"), u(HN)]);
});

test("findAccess: active users allowed with role, inactive/unknown/empty denied", () => {
  const list = frozen([u(HN), u("boss@cmu.ac.th", "admin"), u("off@x.com", "user", false)]);
  assert.deepEqual(findAccess(list, " HNBCMU@gmail.com"), { allowed: true, role: "user" });
  assert.deepEqual(findAccess(list, "boss@cmu.ac.th"), { allowed: true, role: "admin" });
  assert.deepEqual(findAccess(list, "off@x.com"), { allowed: false, role: null });
  assert.deepEqual(findAccess(list, "nobody@x.com"), { allowed: false, role: null });
  assert.deepEqual(findAccess(list, ""), { allowed: false, role: null });
});

test("findAccess: bootstrap admin always allowed as admin", () => {
  assert.deepEqual(findAccess([], ADMIN), { allowed: true, role: "admin" });
  assert.deepEqual(findAccess(frozen([u(ADMIN, "user", false)]), " Nansurg7@GMAIL.com "), { allowed: true, role: "admin" });
});

test("addUser stores a normalized active user and does not mutate input", () => {
  const list = frozen([u(ADMIN, "admin")]);
  const r = addUser(list, "  New.Person@CMU.ac.th ", "user");
  assert.deepEqual(r, { ok: true, users: [u(ADMIN, "admin"), u("new.person@cmu.ac.th", "user")] });
  const r2 = addUser(list, "x@gmail.com", "admin");
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.users.at(-1), u("x@gmail.com", "admin"));
  assert.deepEqual(list, [u(ADMIN, "admin")]);
});

test("addUser rejects invalid emails, duplicates (any case), and bad roles", () => {
  const list = frozen([u(ADMIN, "admin"), u(HN)]);
  for (const bad of ["abc", "a@b", "a b@x.com", ""]) expectError(addUser(list, bad, "user"), /รูปแบบอีเมลไม่ถูกต้อง/);
  expectError(addUser(list, " HNBCMU@Gmail.com ", "user"), /มีอีเมลนี้ในรายชื่อแล้ว/);
  expectError(addUser(list, "Nansurg7@gmail.com", "admin"), /มีอีเมลนี้ในรายชื่อแล้ว/);
  expectError(addUser([], ADMIN, "admin"), /มีอีเมลนี้ในรายชื่อแล้ว/);
  expectError(addUser(list, "new@x.com", "owner"), /สิทธิ์ไม่ถูกต้อง/);
});

test("removeUser removes another user", () => {
  const list = frozen([u(ADMIN, "admin"), u(HN), u("b@x.com", "admin")]);
  assert.deepEqual(removeUser(list, "HNBCMU@gmail.com", ADMIN), { ok: true, users: [u(ADMIN, "admin"), u("b@x.com", "admin")] });
  assert.deepEqual(removeUser(list, "b@x.com", ADMIN), { ok: true, users: [u(ADMIN, "admin"), u(HN)] });
  assert.equal(list.length, 3);
});

test("removeUser rejects bootstrap, self, unknown, last active admin", () => {
  const list = frozen([u(ADMIN, "admin"), u("b@x.com", "admin"), u(HN)]);
  expectError(removeUser(list, " NANSURG7@gmail.com", "b@x.com"), /ผู้ดูแลระบบหลัก/);
  expectError(removeUser(list, ADMIN, ADMIN), /ผู้ดูแลระบบหลัก/);
  expectError(removeUser(list, "b@x.com", " B@X.com "), /ลบบัญชีของตัวเองไม่ได้/);
  expectError(removeUser(list, "ghost@x.com", ADMIN), /ไม่พบอีเมลนี้ในรายชื่อ/);
  // List without the bootstrap entry (store adds it later): the guard must still work.
  const noBoot = frozen([u("a@x.com", "admin"), u("b@x.com", "admin", false), u("c@x.com")]);
  expectError(removeUser(noBoot, "a@x.com", "c@x.com"), /ผู้ดูแลระบบที่ใช้งานอยู่อย่างน้อย 1 คน/);
  // Inactive admin is not the last active admin.
  assert.deepEqual(removeUser(noBoot, "b@x.com", "a@x.com"), { ok: true, users: [u("a@x.com", "admin"), u("c@x.com")] });
});

test("setRole changes role of another user, no-op promotions allowed", () => {
  const list = frozen([u(ADMIN, "admin"), u(HN), u("b@x.com", "admin")]);
  assert.deepEqual(setRole(list, "hnbcmu@gmail.com", "admin", ADMIN).users[1], u(HN, "admin"));
  assert.deepEqual(setRole(list, "b@x.com", "user", ADMIN).users[2], u("b@x.com", "user"));
  assert.equal(setRole(list, ADMIN, "admin", "b@x.com").ok, true);
  assert.equal(setRole(list, "b@x.com", "admin", "b@x.com").ok, true);
  // Two active admins without bootstrap: demoting one is allowed.
  const two = frozen([u("a@x.com", "admin"), u("b@x.com", "admin")]);
  assert.deepEqual(setRole(two, "a@x.com", "user", "b@x.com"), { ok: true, users: [u("a@x.com", "user"), u("b@x.com", "admin")] });
  assert.equal(list[1].role, "user");
});

test("setRole rejects demoting bootstrap, self, unknown, last active admin, bad role", () => {
  const list = frozen([u(ADMIN, "admin"), u("b@x.com", "admin"), u(HN)]);
  expectError(setRole(list, "Nansurg7@gmail.com", "user", "b@x.com"), /ผู้ดูแลระบบหลัก/);
  expectError(setRole(list, "b@x.com", "user", "B@x.com"), /ลดสิทธิ์ของตัวเองไม่ได้/);
  expectError(setRole(list, "ghost@x.com", "user", ADMIN), /ไม่พบอีเมลนี้ในรายชื่อ/);
  expectError(setRole(list, HN, "superuser", ADMIN), /สิทธิ์ไม่ถูกต้อง/);
  const noBoot = frozen([u("a@x.com", "admin"), u("b@x.com", "admin", false), u("c@x.com")]);
  expectError(setRole(noBoot, "a@x.com", "user", "c@x.com"), /ผู้ดูแลระบบที่ใช้งานอยู่อย่างน้อย 1 คน/);
});

test("setActive toggles another user, no-op activations allowed", () => {
  const list = frozen([u(ADMIN, "admin"), u(HN), u("b@x.com", "admin")]);
  assert.deepEqual(setActive(list, " HNBCMU@gmail.com", false, ADMIN).users[1], u(HN, "user", false));
  assert.deepEqual(setActive(list, "b@x.com", false, ADMIN).users[2], u("b@x.com", "admin", false));
  assert.equal(setActive(list, ADMIN, true, "b@x.com").ok, true);
  assert.equal(setActive(list, "b@x.com", true, "b@x.com").ok, true);
  const off = frozen([u(ADMIN, "admin"), u(HN, "user", false)]);
  assert.deepEqual(setActive(off, HN, true, ADMIN).users[1], u(HN));
  assert.equal(list[1].active, true);
});

test("setActive rejects deactivating bootstrap, self, unknown, last active admin, non-boolean", () => {
  const list = frozen([u(ADMIN, "admin"), u("b@x.com", "admin"), u(HN)]);
  expectError(setActive(list, ADMIN, false, "b@x.com"), /ผู้ดูแลระบบหลัก/);
  expectError(setActive(list, "b@x.com", false, "b@x.com"), /ปิดการใช้งานบัญชีของตัวเองไม่ได้/);
  expectError(setActive(list, "ghost@x.com", false, ADMIN), /ไม่พบอีเมลนี้ในรายชื่อ/);
  expectError(setActive(list, HN, "false", ADMIN), /สถานะไม่ถูกต้อง/);
  const noBoot = frozen([u("a@x.com", "admin"), u("b@x.com", "admin", false), u("c@x.com")]);
  expectError(setActive(noBoot, "a@x.com", false, "c@x.com"), /ผู้ดูแลระบบที่ใช้งานอยู่อย่างน้อย 1 คน/);
});
