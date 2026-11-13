// Pure rules for the admin-managed email allowlist. No imports: used by server code and tests.
// Mutations never change their input; they return a new list or a Thai error message.
// Bootstrap injection (withBootstrap) is the store's job on read; the guards below work on the list as given.

export type Role = "user" | "admin";
export type UserRecord = { email: string; role: Role; active: boolean };
export type Access = { allowed: boolean; role: Role | null };
export type Result = { ok: true; users: UserRecord[] } | { ok: false; error: string };

export const BOOTSTRAP_ADMIN = "nansurg7@gmail.com";

export const SEED_USERS: UserRecord[] = [
  { email: BOOTSTRAP_ADMIN, role: "admin", active: true },
  { email: "hnbcmu@gmail.com", role: "user", active: true },
];

// Thai messages of every rule failure (the admin API maps them to HTTP statuses).
export const USER_ERRORS = {
  invalidEmail: "รูปแบบอีเมลไม่ถูกต้อง",
  invalidRole: "สิทธิ์ไม่ถูกต้อง (ต้องเป็น user หรือ admin)",
  invalidActive: "สถานะไม่ถูกต้อง",
  duplicate: "มีอีเมลนี้ในรายชื่อแล้ว",
  notFound: "ไม่พบอีเมลนี้ในรายชื่อ",
  bootstrap: "ลบ ลดสิทธิ์ หรือปิดการใช้งานผู้ดูแลระบบหลักไม่ได้",
  selfRemove: "ลบบัญชีของตัวเองไม่ได้",
  selfDemote: "ลดสิทธิ์ของตัวเองไม่ได้",
  selfDeactivate: "ปิดการใช้งานบัญชีของตัวเองไม่ได้",
  lastAdmin: "ต้องมีผู้ดูแลระบบที่ใช้งานอยู่อย่างน้อย 1 คน",
} as const;
const ERR = USER_ERRORS;

export const MAX_EMAIL_LENGTH = 254;
// Local part: RFC 5322 dot-atom characters only (printable ASCII; no spaces, control or
// zero-width characters, no "<" or ">"), dots not leading, trailing or doubled. "+" tags allowed.
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function normalizeEmail(v: string): string {
  return String(v ?? "").trim().toLowerCase();
}

export function isValidEmail(v: string): boolean {
  const email = normalizeEmail(v);
  if (!email || email.length > MAX_EMAIL_LENGTH || /\s/.test(email)) return false;
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !LOCAL_PART.test(local)) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return false;
  return /^[a-z]{2,}$/.test(labels[labels.length - 1]);
}

function isRole(v: unknown): v is Role {
  return v === "user" || v === "admin";
}

function copy(list: readonly UserRecord[]): UserRecord[] {
  return list.map((r) => ({ email: normalizeEmail(r.email), role: r.role, active: r.active }));
}

// Normalizes and dedupes (first occurrence wins), then forces the bootstrap admin to be an
// active admin, keeping its position or prepending it when missing.
export function withBootstrap(list: readonly UserRecord[]): UserRecord[] {
  const seen = new Set<string>();
  const out: UserRecord[] = [];
  for (const r of list) {
    const email = normalizeEmail(r.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(
      email === BOOTSTRAP_ADMIN
        ? { email, role: "admin", active: true }
        : { email, role: isRole(r.role) ? r.role : "user", active: r.active === true },
    );
  }
  if (!seen.has(BOOTSTRAP_ADMIN)) out.unshift({ email: BOOTSTRAP_ADMIN, role: "admin", active: true });
  return out;
}

export function findAccess(list: readonly UserRecord[], email: string): Access {
  const target = normalizeEmail(email);
  if (target === BOOTSTRAP_ADMIN) return { allowed: true, role: "admin" };
  if (!target) return { allowed: false, role: null };
  const record = list.find((r) => normalizeEmail(r.email) === target);
  if (!record || record.active !== true || !isRole(record.role)) return { allowed: false, role: null };
  return { allowed: true, role: record.role };
}

function indexOf(list: readonly UserRecord[], email: string): number {
  return list.findIndex((r) => normalizeEmail(r.email) === email);
}

// True when the record at `index` is the only active admin in the list.
function isLastActiveAdmin(list: readonly UserRecord[], index: number): boolean {
  const target = list[index];
  if (target.role !== "admin" || target.active !== true) return false;
  return !list.some((r, i) => i !== index && r.role === "admin" && r.active === true);
}

export function addUser(list: readonly UserRecord[], email: string, role: Role): Result {
  const target = normalizeEmail(email);
  if (!isValidEmail(target)) return { ok: false, error: ERR.invalidEmail };
  if (!isRole(role)) return { ok: false, error: ERR.invalidRole };
  if (target === BOOTSTRAP_ADMIN || indexOf(list, target) !== -1) return { ok: false, error: ERR.duplicate };
  return { ok: true, users: [...copy(list), { email: target, role, active: true }] };
}

export function removeUser(list: readonly UserRecord[], email: string, actor: string): Result {
  const target = normalizeEmail(email);
  if (!target) return { ok: false, error: ERR.invalidEmail };
  if (target === BOOTSTRAP_ADMIN) return { ok: false, error: ERR.bootstrap };
  if (target === normalizeEmail(actor)) return { ok: false, error: ERR.selfRemove };
  const index = indexOf(list, target);
  if (index === -1) return { ok: false, error: ERR.notFound };
  if (isLastActiveAdmin(list, index)) return { ok: false, error: ERR.lastAdmin };
  return { ok: true, users: copy(list).filter((_, i) => i !== index) };
}

export function setRole(list: readonly UserRecord[], email: string, role: Role, actor: string): Result {
  if (!isRole(role)) return { ok: false, error: ERR.invalidRole };
  const target = normalizeEmail(email);
  if (!target) return { ok: false, error: ERR.invalidEmail };
  const demoting = role !== "admin";
  if (demoting && target === BOOTSTRAP_ADMIN) return { ok: false, error: ERR.bootstrap };
  if (demoting && target === normalizeEmail(actor)) return { ok: false, error: ERR.selfDemote };
  const index = indexOf(list, target);
  if (index === -1) return { ok: false, error: ERR.notFound };
  if (demoting && isLastActiveAdmin(list, index)) return { ok: false, error: ERR.lastAdmin };
  const users = copy(list);
  users[index] = { ...users[index], role };
  return { ok: true, users };
}

export function setActive(list: readonly UserRecord[], email: string, active: boolean, actor: string): Result {
  if (typeof active !== "boolean") return { ok: false, error: ERR.invalidActive };
  const target = normalizeEmail(email);
  if (!target) return { ok: false, error: ERR.invalidEmail };
  if (!active && target === BOOTSTRAP_ADMIN) return { ok: false, error: ERR.bootstrap };
  if (!active && target === normalizeEmail(actor)) return { ok: false, error: ERR.selfDeactivate };
  const index = indexOf(list, target);
  if (index === -1) return { ok: false, error: ERR.notFound };
  if (!active && isLastActiveAdmin(list, index)) return { ok: false, error: ERR.lastAdmin };
  const users = copy(list);
  users[index] = { ...users[index], active };
  return { ok: true, users };
}
