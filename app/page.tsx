import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth, AUTHORIZED_EMAIL } from "../auth";
import SchedulerApp from "./SchedulerApp";

export const metadata: Metadata = {
  title: "OR Queue | Breast & Endocrine Surgery CMU",
  description: "ระบบลงคิวผ่าตัด OR 17 และ OR Extra",
};

export default async function Home() {
  const session = await auth();
  if (session?.user?.email?.toLowerCase() !== AUTHORIZED_EMAIL) redirect("/signin");
  return <SchedulerApp authorizedEmail={AUTHORIZED_EMAIL} />;
}
