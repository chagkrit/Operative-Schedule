import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { sessionAccess } from "../lib/session";
import { userStore } from "../lib/user-store";
import type { UserRecord } from "../lib/users";
import AdminUsers from "./AdminUsers";

export const metadata: Metadata = {
  title: "จัดการผู้ใช้ | OR Queue",
  description: "รายชื่อบัญชี Google ที่เข้าใช้ระบบลงคิวผ่าตัดได้",
};

export default async function AdminPage() {
  // redirect() throws NEXT_REDIRECT, so both checks stay outside the try below.
  const access = await sessionAccess();
  if (!access) redirect("/signin");
  if (access.role !== "admin") redirect("/");

  let users: UserRecord[] | null = null;
  try {
    users = await userStore.list();
  } catch (err) {
    console.error("[admin] user list unreadable:", err instanceof Error ? err.name : typeof err);
  }

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <Link className="admin-back" href="/">← กลับหน้าคิวผ่าตัด</Link>
        <p className="eyebrow pink">BREAST &amp; ENDOCRINE SURGERY CMU · OR QUEUE</p>
        <h1>จัดการผู้ใช้</h1>
        <p className="admin-intro">
          เพิ่มบัญชี Google ที่เข้าใช้ระบบได้ เปลี่ยนสิทธิ์ ปิดการใช้งานชั่วคราว หรือลบออก
          การปิดหรือลบมีผลกับคนที่เข้าระบบค้างอยู่ภายในประมาณ 30 วินาที
        </p>
      </header>
      {users ? (
        <AdminUsers initialUsers={users} currentEmail={access.email} />
      ) : (
        <section className="panel admin-panel">
          <p className="admin-load-error" role="alert">อ่านรายชื่อผู้ใช้ไม่สำเร็จ กรุณาโหลดหน้านี้ใหม่อีกครั้ง</p>
        </section>
      )}
    </main>
  );
}
