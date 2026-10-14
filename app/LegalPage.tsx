import Link from "next/link";
import type { ReactNode } from "react";

export const LEGAL_CONTACT_EMAIL = "nansurg7@gmail.com";
export const LEGAL_UPDATED = "14 ตุลาคม 2569 (2026-10-14)";

export default function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="legal-shell">
      <article className="legal-card">
        <p className="eyebrow pink">BREAST &amp; ENDOCRINE SURGERY CMU · OR QUEUE</p>
        <h1>{title}</h1>
        <p className="legal-meta">ปรับปรุงล่าสุด {LEGAL_UPDATED}</p>
        {children}
        <nav className="legal-nav" aria-label="เอกสารของระบบ">
          <Link href="/signin">กลับหน้าเข้าสู่ระบบ</Link>
          <Link href="/privacy">นโยบายความเป็นส่วนตัว</Link>
          <Link href="/terms">ข้อกำหนดการใช้งาน</Link>
        </nav>
      </article>
    </main>
  );
}
