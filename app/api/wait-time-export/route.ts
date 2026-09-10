import { listCalendarData } from "../../lib/calendar";
import { daysBetween } from "../../lib/schedule";
import { createWaitingTimeWorkbook } from "../../lib/xlsx";

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const from = params.get("from") || "";
    const to = params.get("to") || "";
    if (!isIsoDate(from) || !isIsoDate(to) || from > to) {
      return Response.json({ error: "กรุณาระบุช่วงวันผ่าตัดให้ถูกต้อง" }, { status: 400 });
    }

    const { bookings } = await listCalendarData(request, from, to);
    const rows = [[
      { value: "วันที่ลงคิว", kind: "header" as const },
      { value: "วันผ่าตัด", kind: "header" as const },
      { value: "ระยะเวลารอผ่าตัด (วัน)", kind: "header" as const },
      { value: "ประเภทคิว", kind: "header" as const },
      { value: "ลำดับคิว", kind: "header" as const },
      { value: "Diagnosis", kind: "header" as const },
      { value: "ได้รับ neoadjuvant treatment มาก่อน", kind: "header" as const },
      { value: "Operation", kind: "header" as const },
      { value: "Staff", kind: "header" as const },
      { value: "จำนวนครั้งที่ย้ายคิว", kind: "header" as const },
      { value: "วันที่ย้ายล่าสุด", kind: "header" as const },
    ], ...bookings
      .sort((a, b) => a.scheduleDate.localeCompare(b.scheduleDate) || a.slotNo - b.slotNo)
      .map((booking) => [
        { value: booking.queuedDate, kind: "date" as const },
        { value: booking.scheduleDate, kind: "date" as const },
        { value: daysBetween(booking.queuedDate, booking.scheduleDate), kind: "number" as const },
        { value: booking.queueType === "EXTRA" ? "OR Extra" : "OR 17" },
        { value: booking.slotNo, kind: "number" as const },
        { value: booking.diagnosis },
        { value: booking.neoadjuvantTreatment === true ? "ได้รับ" : booking.neoadjuvantTreatment === false ? "ไม่ได้รับ" : "ไม่ระบุ" },
        { value: booking.operation },
        { value: booking.staffMembers.join(", ") },
        { value: booking.moveCount, kind: "number" as const },
        { value: booking.lastMoveAt },
      ])];
    const filename = `operative-waiting-time_${from}_to_${to}.xlsx`;
    return new Response(createWaitingTimeWorkbook(rows), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const status = (error as { status?: number }).status || 500;
    return Response.json(
      { error: error instanceof Error ? error.message : "Export ข้อมูลเวลารอผ่าตัดไม่สำเร็จ" },
      { status },
    );
  }
}
