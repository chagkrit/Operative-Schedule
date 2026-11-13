import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signInWithGoogle } from "./actions";
import { sessionAccess, sessionEmail } from "../lib/session";

// Also shown while the permission check is temporarily down (the user store fails closed).
const DENIED_MESSAGE = "บัญชีนี้ยังไม่ได้รับอนุญาต ถูกปิดการใช้งาน หรือระบบตรวจสิทธิ์ขัดข้องชั่วคราว กรุณาลองใหม่หรือติดต่อผู้ดูแลระบบ";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  if (await sessionAccess()) redirect("/");
  // Signed in but not (or no longer) allowed, or Auth.js refused the sign-in (not on the list).
  // The session is left alone: no sign-out, no redirect loop.
  const { error } = await searchParams;
  const denied = Boolean(await sessionEmail()) || error === "AccessDenied";

  return (
    <main className="signin-shell">
      <section className="signin-card">
        <Image src="/unit-logo.jpg" alt="Breast & Endocrine Surgery CMU" className="signin-logo" width={104} height={104} priority />
        <p className="eyebrow pink">BREAST &amp; ENDOCRINE SURGERY CMU</p>
        <h1>OR Queue</h1>
        <p>ระบบลงคิวผ่าตัดของหน่วย เชื่อมต่อ Google Calendar แบบทันที</p>
        {denied && <p className="signin-denied" role="alert">{DENIED_MESSAGE}</p>}
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
