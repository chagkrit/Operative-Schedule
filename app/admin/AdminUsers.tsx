"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import ConfirmDialog from "../ConfirmDialog";
import { BOOTSTRAP_ADMIN, type Role, type UserRecord } from "../lib/users";

type Notice = { type: "success" | "error"; text: string } | null;
type ApiPayload = { users?: unknown; error?: unknown };
type Method = "GET" | "POST" | "PATCH" | "DELETE";

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "user", label: "ผู้ใช้ (user)" },
  { value: "admin", label: "ผู้ดูแลระบบ (admin)" },
];

function fallbackError(status: number) {
  if (status === 401) return "กรุณาเข้าสู่ระบบใหม่อีกครั้ง";
  if (status === 403) return "เฉพาะผู้ดูแลระบบเท่านั้น";
  return "ทำรายการไม่สำเร็จ กรุณาลองใหม่";
}

// The allowlist editor. Every change goes through /api/admin/users and the list on screen is
// always the `users` the server answered with (the saved list), never a local guess.
export default function AdminUsers({ initialUsers, currentEmail }: { initialUsers: UserRecord[]; currentEmail: string }) {
  const [users, setUsers] = useState<UserRecord[]>(initialUsers);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<Role>("user");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);

  // Confirm dialog: focus "ยกเลิก" on open; Esc cancels (not while the delete is in flight).
  useEffect(() => {
    if (!pendingDelete) return;
    cancelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        setPendingDelete(null);
        deleteTriggerRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingDelete, busy]);

  async function send(method: Method, body: Record<string, unknown> | null, success: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/users", {
        method,
        cache: "no-store",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await response.json().catch(() => ({}))) as ApiPayload;
      if (!response.ok || !Array.isArray(data.users)) {
        setNotice({ type: "error", text: typeof data.error === "string" && data.error ? data.error : fallbackError(response.status) });
        return false;
      }
      setUsers(data.users as UserRecord[]);
      setNotice({ type: "success", text: success });
      return true;
    } catch {
      setNotice({ type: "error", text: "เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = newEmail.trim();
    if (!email) {
      setNotice({ type: "error", text: "กรุณากรอกอีเมล" });
      return;
    }
    if (await send("POST", { email, role: newRole }, `เพิ่ม ${email.toLowerCase()} แล้ว`)) {
      setNewEmail("");
      setNewRole("user");
    }
  }

  function changeRole(user: UserRecord, role: Role) {
    if (role === user.role) return;
    void send("PATCH", { email: user.email, role }, `เปลี่ยนสิทธิ์ ${user.email} เป็น ${role === "admin" ? "ผู้ดูแลระบบ" : "ผู้ใช้"} แล้ว`);
  }

  function toggleActive(user: UserRecord) {
    const active = !user.active;
    void send(
      "PATCH",
      { email: user.email, active },
      active ? `เปิดใช้งาน ${user.email} แล้ว` : `ปิดการใช้งาน ${user.email} ชั่วคราวแล้ว (มีผลภายในประมาณ 30 วินาที)`,
    );
  }

  function askDelete(email: string, trigger: HTMLElement) {
    deleteTriggerRef.current = trigger;
    setPendingDelete(email);
  }

  function cancelDelete() {
    setPendingDelete(null);
    deleteTriggerRef.current?.focus();
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const email = pendingDelete;
    const ok = await send("DELETE", { email }, `ลบ ${email} ออกจากรายชื่อแล้ว`);
    setPendingDelete(null);
    // The row (and its button) is gone after a delete: move focus to the list heading instead.
    // Next frame: the trigger is still disabled until busy=false has rendered.
    requestAnimationFrame(() => (ok ? listHeadingRef.current : deleteTriggerRef.current)?.focus());
  }

  const activeCount = users.filter((user) => user.active).length;

  return (
    <>
      <section className="panel admin-panel" aria-labelledby="admin-add-title">
        <h2 id="admin-add-title">เพิ่มผู้ใช้</h2>
        <form className="admin-add-form" onSubmit={addUser} noValidate>
          <label className="field">
            <span>อีเมล Google</span>
            <input
              type="email"
              inputMode="email"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="name@gmail.com"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>สิทธิ์</span>
            <select value={newRole} onChange={(event) => setNewRole(event.target.value as Role)} disabled={busy}>
              {ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <button type="submit" disabled={busy} aria-busy={busy}>{busy ? "กำลังบันทึก…" : "เพิ่มผู้ใช้"}</button>
        </form>
        <p className={`admin-notice ${notice?.type || ""}`} role="status" aria-live="polite">{notice?.text || ""}</p>
      </section>

      <section className="panel admin-panel" aria-labelledby="admin-list-title">
        <div className="admin-list-heading">
          <h2 id="admin-list-title" ref={listHeadingRef} tabIndex={-1}>รายชื่อผู้ใช้</h2>
          <span className="admin-summary">ทั้งหมด {users.length} บัญชี · ใช้งาน {activeCount}</span>
          <button className="admin-reload" type="button" onClick={() => void send("GET", null, "โหลดรายชื่อล่าสุดแล้ว")} disabled={busy}>โหลดรายชื่อใหม่</button>
        </div>
        <ul className="admin-list">
          {users.map((user) => {
            const isBootstrap = user.email === BOOTSTRAP_ADMIN;
            const isSelf = user.email === currentEmail;
            const locked = isBootstrap || isSelf;
            const note = isBootstrap ? "ผู้ดูแลระบบหลัก · แก้ไขหรือลบไม่ได้" : isSelf ? "บัญชีของคุณ · แก้ไขสิทธิ์ของตัวเองไม่ได้" : "";
            return (
              <li key={user.email} className="admin-row" data-active={user.active}>
                <div className="admin-row-main">
                  <strong className="admin-email">{user.email}</strong>
                  {note && <small className="admin-note">{note}</small>}
                </div>
                <div className="admin-row-controls">
                  <select
                    aria-label={`สิทธิ์ของ ${user.email}`}
                    value={user.role}
                    onChange={(event) => changeRole(user, event.target.value as Role)}
                    disabled={locked || busy}
                  >
                    {ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <button
                    className="admin-toggle"
                    type="button"
                    role="switch"
                    aria-checked={user.active}
                    aria-label={`สถานะของ ${user.email}: ${user.active ? "ใช้งาน" : "ปิดชั่วคราว"}`}
                    onClick={() => toggleActive(user)}
                    disabled={locked || busy}
                  >
                    {user.active ? "ใช้งาน" : "ปิดชั่วคราว"}
                  </button>
                  <button
                    className="admin-delete"
                    type="button"
                    aria-label={`ลบ ${user.email}`}
                    onClick={(event) => askDelete(user.email, event.currentTarget)}
                    disabled={locked || busy}
                  >
                    ลบ
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {pendingDelete && (
        <ConfirmDialog
          title="ลบผู้ใช้"
          message={`ลบ ${pendingDelete} ออกจากรายชื่อ? บัญชีนี้จะเข้าใช้ระบบไม่ได้อีกจนกว่าจะเพิ่มใหม่`}
          confirmLabel="ลบผู้ใช้"
          busy={busy}
          cancelRef={cancelRef}
          onCancel={cancelDelete}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </>
  );
}
