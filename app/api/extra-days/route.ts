import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { extraDays } from "../../../db/schema";
import { dateOnly, isExtraEligibleDay } from "../../lib/schedule";
import { getSiteUser } from "../../lib/site-user";

export async function POST(request: Request) {
  const user = getSiteUser(request);
  if (!user) return Response.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  try {
    const payload = (await request.json()) as {
      date?: string;
      capacity?: number;
      note?: string;
    };
    const date = payload.date?.trim() || "";
    const capacity = Number(payload.capacity || 4);
    const note = payload.note?.trim() || "";
    if (!date || date < dateOnly()) {
      return Response.json({ error: "กรุณาเลือกวันที่วันนี้เป็นต้นไป" }, { status: 400 });
    }
    if (!isExtraEligibleDay(date)) {
      return Response.json(
        { error: "OR Extra กำหนดได้เฉพาะวันจันทร์หรือพฤหัสบดี" },
        { status: 400 },
      );
    }
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) {
      return Response.json({ error: "จำนวนเคสต้องอยู่ระหว่าง 1–8" }, { status: 400 });
    }
    await getDb()
      .insert(extraDays)
      .values({ date, capacity, note, createdByEmail: user.email })
      .onConflictDoUpdate({
        target: extraDays.date,
        set: { capacity, note, createdByEmail: user.email },
      });
    return Response.json({ message: "กำหนด OR Extra แล้ว" }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "บันทึกไม่สำเร็จ";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!getSiteUser(request)) {
    return Response.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }
  const date = new URL(request.url).searchParams.get("date") || "";
  if (!date) return Response.json({ error: "ไม่พบวันที่" }, { status: 400 });
  await getDb().delete(extraDays).where(eq(extraDays.date, date));
  return Response.json({ message: "ยกเลิก OR Extra แล้ว" });
}
