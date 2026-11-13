import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AUTHORIZED_EMAIL } from "../auth";
import { sessionAccess } from "./lib/session";
import SchedulerApp from "./SchedulerApp";

export const metadata: Metadata = {
  title: "OR Queue | Breast & Endocrine Surgery CMU",
  description: "ระบบลงคิวผ่าตัด OR 17 และ OR Extra",
};

export default async function Home() {
  // Not allowed (or the list is unreadable): send to /signin without touching the session.
  const access = await sessionAccess();
  if (!access) redirect("/signin");
  return (
    <Suspense fallback={null}>
      <SchedulerApp authorizedEmail={AUTHORIZED_EMAIL} isAdmin={access.role === "admin"} />
    </Suspense>
  );
}
