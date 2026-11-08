import { AUTHORIZED_EMAIL } from "../../../auth";
import { affectedBookingView } from "../../lib/affected-booking";
import {
  deleteStaffUnavailabilityEvent,
  listCalendarData,
  saveStaffUnavailabilityEvent,
} from "../../lib/calendar";
import {
  dateOnly,
  endOfRollingHorizon,
  isStaffOption,
  orderedStaffMembers,
  STAFF_OPTIONS,
} from "../../lib/schedule";
import {
  caseStaffStatus,
  conflictingEntries,
  findOverlappingStaff,
  isIsoDate,
  yieldsToConcurrentEntry,
} from "../../lib/staff-unavailability";

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" }, { status: 400 });
    }
    const payload = body as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : null);
    const id = text(payload.id);
    const startDate = text(payload.startDate);
    const endDate = text(payload.endDate);
    const note = text(payload.note);
    if (id === null || startDate === null || endDate === null || note === null) {
      return Response.json({ error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" }, { status: 400 });
    }
    const today = dateOnly();
    const horizonEnd = endOfRollingHorizon(today);
    const dateError = () => Response.json({ error: `กรุณาเลือกวันที่ไม่ว่างตั้งแต่วันนี้ถึง ${horizonEnd} และวันเริ่มต้องไม่เกินวันสิ้นสุด` }, { status: 400 });
    if (!isIsoDate(startDate) || !isIsoDate(endDate) || endDate < today || endDate > horizonEnd || startDate > endDate) {
      return dateError();
    }
    if (note.length > 500) {
      return Response.json({ error: "หมายเหตุยาวเกินกำหนด" }, { status: 400 });
    }

    let requested: string[] = [];
    if (!id) {
      const raw: unknown[] = Array.isArray(payload.staff) ? payload.staff : [];
      if (
        raw.length === 0 ||
        raw.some((name) => typeof name !== "string" || !isStaffOption(name)) ||
        new Set(raw).size !== raw.length
      ) {
        return Response.json({ error: "กรุณาเลือก staff อย่างน้อย 1 คน (เลือกซ้ำไม่ได้)" }, { status: 400 });
      }
      requested = orderedStaffMembers(raw as string[]);
    }

    const current = await listCalendarData(request, today, horizonEnd);
    const existing = id ? current.staffUnavailability.find((entry) => entry.id === id) : undefined;
    if (id && !existing) return Response.json({ error: "ไม่พบรายการวันที่ไม่ว่างที่ต้องการแก้ไข" }, { status: 404 });
    // Decision 12 (no past dates) applies to new start dates; an in-progress entry may keep its original start.
    if (startDate < today && !(existing && startDate === existing.startDate)) return dateError();
    const selected = existing ? [existing.staff] : requested;

    const overlappingStaff = findOverlappingStaff(
      current.staffUnavailability,
      selected,
      { startDate, endDate },
      existing?.id,
    );
    if (overlappingStaff.length > 0) {
      return Response.json({
        error: `${overlappingStaff.join(", ")} มีวันที่ไม่ว่างทับซ้อนกับช่วงวันที่เลือกแล้ว กรุณาแก้ไขรายการเดิม`,
        overlappingStaff,
      }, { status: 409 });
    }

    const affectedBookings = current.bookings
      .filter((booking) =>
        booking.scheduleDate >= (startDate < today ? today : startDate) &&
        booking.scheduleDate <= endDate &&
        caseStaffStatus(booking.staffMembers, selected, STAFF_OPTIONS).unavailableStaff.length > 0)
      .sort((a, b) => a.scheduleDate.localeCompare(b.scheduleDate) || a.queueType.localeCompare(b.queueType) || a.slotNo - b.slotNo)
      .map(affectedBookingView);
    if (affectedBookings.length > 0 && !payload.confirmExistingBookings) {
      return Response.json({
        requiresConfirmation: true,
        affectedBookings,
        message: `ช่วงวันที่เลือกมีคิวเดิมของ staff ที่ไม่ว่าง ${affectedBookings.length} เคส คิวเดิมจะยังอยู่และจะแสดงป้าย "ควรย้ายวัน"`,
      }, { status: 409 });
    }

    const entries: { id: string; staff: string; startDate: string; endDate: string; note: string }[] = [];
    const concurrentMessage = (staff: string[]) =>
      `${staff.join(", ")} มีผู้บันทึกวันที่ไม่ว่างทับซ้อนพร้อมกัน ระบบไม่ได้บันทึกรายการนี้ กรุณาตรวจสอบรายการแล้วบันทึกอีกครั้ง`;
    try {
      for (const staff of selected) {
        const savedId = await saveStaffUnavailabilityEvent(request, {
          id: existing?.id,
          staff,
          startDate,
          endDate,
          note,
          updatedBy: AUTHORIZED_EMAIL,
          createdAt: existing?.createdAt,
          createdBy: existing?.createdBy,
        });
        entries.push({ id: savedId, staff, startDate, endDate, note });
      }
      // The overlap check above and the writes are not atomic: re-read and undo if another save raced us.
      const verified = await listCalendarData(request, today, horizonEnd);
      const clashed = entries.filter((entry) => {
        const others = conflictingEntries(verified.staffUnavailability, entry.staff, { startDate, endDate }, entry.id);
        return existing ? others.length > 0 : yieldsToConcurrentEntry(entry.id, others);
      });
      if (clashed.length > 0) {
        if (existing) {
          await saveStaffUnavailabilityEvent(request, {
            id: existing.id,
            staff: existing.staff,
            startDate: existing.startDate,
            endDate: existing.endDate,
            note: existing.note,
            updatedBy: AUTHORIZED_EMAIL,
            createdAt: existing.createdAt,
            createdBy: existing.createdBy,
          });
        } else {
          await Promise.all(entries.map((entry) => deleteStaffUnavailabilityEvent(request, entry.id)));
        }
        return Response.json({ error: concurrentMessage(clashed.map((entry) => entry.staff)) }, { status: 409 });
      }
    } catch (error) {
      if (!existing) {
        await Promise.allSettled(entries.map((entry) => deleteStaffUnavailabilityEvent(request, entry.id)));
      }
      throw error;
    }
    return Response.json({
      entries,
      affectedBookings,
      message: affectedBookings.length
        ? `บันทึกวันที่ไม่ว่างแล้ว โดยคงคิวเดิม ${affectedBookings.length} เคสไว้ (ควรย้ายวัน)`
        : "บันทึกวันที่ staff ไม่ว่างใน Google Calendar แล้ว",
    }, { status: id ? 200 : 201 });
  } catch (error) {
    const status = (error as { status?: number }).status || 500;
    return Response.json({ error: error instanceof Error ? error.message : "บันทึกวันที่ไม่ว่างไม่สำเร็จ" }, { status });
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id")?.trim() || "";
    if (!id) return Response.json({ error: "ไม่พบรายการวันที่ไม่ว่าง" }, { status: 400 });
    const today = dateOnly();
    const current = await listCalendarData(request, today, endOfRollingHorizon(today));
    const entry = current.staffUnavailability.find((item) => item.id === id);
    if (!entry) return Response.json({ error: "ไม่พบรายการวันที่ไม่ว่าง" }, { status: 404 });
    await deleteStaffUnavailabilityEvent(request, id);
    return Response.json({ message: "ลบวันที่ไม่ว่างแล้ว" });
  } catch (error) {
    const status = (error as { status?: number }).status || 500;
    return Response.json({ error: error instanceof Error ? error.message : "ลบวันที่ไม่ว่างไม่สำเร็จ" }, { status });
  }
}
