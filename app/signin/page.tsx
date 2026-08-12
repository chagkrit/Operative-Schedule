import Image from "next/image";
import { auth, AUTHORIZED_EMAIL } from "../../auth";
import { redirect } from "next/navigation";
import { signInWithGoogle } from "./actions";

export default async function SignInPage() {
  const session = await auth();
  if (session?.user?.email?.toLowerCase() === AUTHORIZED_EMAIL) redirect("/");

  return (
    <main className="signin-shell">
      <section className="signin-card">
        <Image src="/unit-logo.jpg" alt="Breast & Endocrine Surgery CMU" width={104} height={104} priority />
        <p className="eyebrow pink">BREAST &amp; ENDOCRINE SURGERY CMU</p>
        <h1>OR Queue</h1>
        <p>ระบบลงคิวผ่าตัดของหน่วย เชื่อมต่อ Google Calendar แบบทันที</p>
        <form action={signInWithGoogle}>
          <button className="google-button" type="submit">เข้าสู่ระบบด้วย Google</button>
        </form>
        <small>อนุญาตเฉพาะบัญชี <strong>{AUTHORIZED_EMAIL}</strong></small>
      </section>
    </main>
  );
}
