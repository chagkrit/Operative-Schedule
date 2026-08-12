import type { Metadata } from "next";
import SchedulerApp from "./SchedulerApp";

export const metadata: Metadata = {
  title: "OR Queue | Breast & Endocrine Surgery CMU",
  description: "ระบบลงคิวผ่าตัด OR 17 และ OR Extra",
};

export default function Home() {
  return <SchedulerApp />;
}
