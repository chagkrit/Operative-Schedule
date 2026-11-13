import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signInWithGoogle } from "./actions";
import { sessionAccess } from "../lib/session";

export default async function SignInPage() {
  if (await sessionAccess()) redirect("/");

  return (
    <main className="signin-shell">
      <section className="signin-card">
        <Image src="/unit-logo.jpg" alt="Breast & Endocrine Surgery CMU" className="signin-logo" width={104} height={104} priority />
        <p className="eyebrow pink">BREAST &amp; ENDOCRINE SURGERY CMU</p>
        <h1>OR Queue</h1>
        <p>ระบบลงคิวผ่าตัดของหน่วย เชื่อมต่อ Google Calendar แบบทันที</p>
        <form action={signInWithGoogle}>
          <button className="google-button" type="submit">เข้าสู่ระบบด้วย Google</button>
        </form>
        <nav className="signin-legal" aria-label="เอกสารของระบบ">
          <Link href="/privacy">นโยบายความเป็นส่วนตัว</Link>
          <Link href="/terms">ข้อกำหนดการใช้งาน</Link>
        </nav>
      </section>
    </main>
  );
}
