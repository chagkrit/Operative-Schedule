import { affectedBookingView } from "../../lib/affected-booking";
import {
  deleteStaffUnavailabilityEvent,
  ifMatchForRestore,
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
import { undoCalendarWrite, type UndoOutcome } from "../../lib/calendar-undo";
import {
  caseStaffStatus,
  conflictingEntries,
  findOverlappingStaff,
  isIsoDate,
} from "../../lib/staff-unavailability";
import { requestUserEmail } from "../../lib/session";

export async function POST(request: Request) {
  try {
    const actorEmail = await requestUserEmail(request);
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

    const entries: { id: string; etag: string; staff: string; startDate: string; endDate: string; note: string }[] = [];
    const undoWrite = () => undoCalendarWrite({
      editing: Boolean(existing),
      writtenIds: entries.map((entry) => entry.id),
      restore: async () => saveStaffUnavailabilityEvent(request, {
        id: existing!.id,
        staff: existing!.staff,
        startDate: existing!.startDate,
        endDate: existing!.endDate,
        note: existing!.note,
        updatedBy: existing!.updatedBy,
        createdAt: existing!.createdAt,
        createdBy: existing!.createdBy,
      }, { ifMatch: await ifMatchForRestore(request, existing!.id, entries[0]?.etag || "", { startDate, endDate }) }),
      remove: (entryId) => deleteStaffUnavailabilityEvent(request, entryId),
    });
    // After an edit is restored, the old range may itself overlap an entry saved meanwhile
    // (that save checked against our edited range). It cannot be fixed without deleting someone's
    // entry, so it is detected and reported for a person to resolve.
    const restoredRangeClash = async () => {
      if (!existing) return false;
      try {
        const after = await listCalendarData(request, today, horizonEnd);
        return conflictingEntries(after.staffUnavailability, existing.staff, existing, existing.id).length > 0;
      } catch {
        return true;
      }
    };
    const names = (list: string[]) => list.join(", ");
    const restoredClashNote = " แต่ช่วงวันเดิมของรายการนี้อาจทับซ้อนกับรายการที่บันทึกพร้อมกัน กรุณาโหลดข้อมูลใหม่แล้วแก้ไขรายการใดรายการหนึ่ง";
    const clashMessage = (clashedStaff: string[], outcome: UndoOutcome, restoredClash: boolean) => {
      const head = `${names(clashedStaff)} มีผู้บันทึกวันที่ไม่ว่างทับซ้อนพร้อมกัน`;
      const others = selected.filter((name) => !clashedStaff.includes(name));
      if (existing) {
        if (outcome === "undone") {
          return restoredClash
            ? `${head} ระบบคืนค่าการแก้ไขนี้แล้ว${restoredClashNote}`
            : `${head} ระบบคืนค่าการแก้ไขนี้แล้ว กรุณาตรวจสอบรายการแล้วบันทึกอีกครั้ง`;
        }
        if (outcome === "changed") return `${head} และรายการนี้ถูกแก้ไขโดยผู้อื่นอีกครั้งระหว่างนั้น ระบบจึงไม่คืนค่าเพื่อไม่ให้ทับการแก้ไขนั้น กรุณาโหลดข้อมูลใหม่แล้วตรวจสอบ`;
        if (outcome === "uncertain") return `${head} และระบบไม่แน่ใจว่าคืนค่าการแก้ไขสำเร็จหรือไม่ กรุณาโหลดข้อมูลใหม่แล้วตรวจสอบรายการนี้`;
        return `${head} และระบบคืนค่าการแก้ไขไม่สำเร็จ รายการนี้อาจทับซ้อนอยู่ กรุณาโหลดข้อมูลใหม่แล้วแก้ไขรายการ`;
      }
      if (outcome === "failed") return `${head} และระบบลบรายการที่เพิ่งบันทึกไม่สำเร็จ อาจมีรายการซ้ำซ้อนอยู่ กรุณาโหลดข้อมูลใหม่แล้วลบรายการที่ซ้ำ`;
      return `${head} ระบบไม่ได้บันทึกรายการใดในคำขอนี้${others.length ? ` (รวมถึง ${names(others)})` : ""} กรุณาตรวจสอบรายการแล้วบันทึกอีกครั้ง`;
    };
    const verifyFailedMessage = (outcome: UndoOutcome, restoredClash: boolean) => {
      const head = "ตรวจสอบรายการหลังบันทึกไม่สำเร็จ";
      if (outcome === "undone") {
        return `${head} ระบบ${existing ? "คืนค่าการแก้ไขนี้" : "ยกเลิกการบันทึกนี้"}แล้ว${restoredClash ? restoredClashNote : " กรุณาลองใหม่"}`;
      }
      if (outcome === "changed") return `${head} และรายการนี้ถูกแก้ไขโดยผู้อื่นระหว่างนั้น กรุณาโหลดข้อมูลใหม่แล้วตรวจสอบ`;
      if (outcome === "uncertain") return `${head} และระบบไม่แน่ใจว่าคืนค่าสำเร็จหรือไม่ กรุณาโหลดข้อมูลใหม่แล้วตรวจสอบรายการนี้`;
      return `${head} และ${existing ? "คืนค่า" : "ยกเลิกการบันทึก"}ไม่สำเร็จ รายการที่บันทึกอาจยังอยู่ กรุณาโหลดข้อมูลใหม่แล้วตรวจสอบ`;
    };
    const undoAndCheck = async () => {
      const outcome = await undoWrite();
      const restoredClash = outcome === "undone" && Boolean(existing) && await restoredRangeClash();
      return { outcome, restoredClash };
    };

    try {
      for (const staff of selected) {
        const saved = await saveStaffUnavailabilityEvent(request, {
          id: existing?.id,
          staff,
          startDate,
          endDate,
          note,
          updatedBy: actorEmail,
          createdAt: existing?.createdAt,
          createdBy: existing?.createdBy,
        });
        entries.push({ ...saved, staff, startDate, endDate, note });
      }
    } catch (error) {
      // A failed PATCH changed nothing; a failed create batch removes what it already wrote,
      // and says so if that cleanup fails too.
      if (!existing && (await undoWrite()) === "failed") {
        const message = error instanceof Error ? error.message : "บันทึกวันที่ไม่ว่างไม่สำเร็จ";
        throw Object.assign(
          new Error(`${message} และลบรายการที่บันทึกไปแล้วบางส่วนไม่สำเร็จ อาจมีรายการค้างอยู่ กรุณาโหลดข้อมูลใหม่แล้วตรวจสอบ`),
          { status: (error as { status?: number }).status },
        );
      }
      throw error;
    }

    // The overlap check above and the writes are not atomic: re-read and undo if another save raced us.
    // If the re-read itself fails, fail closed (call H): undo rather than keep an unverified save.
    let verified: Awaited<ReturnType<typeof listCalendarData>>;
    try {
      verified = await listCalendarData(request, today, horizonEnd);
    } catch {
      const { outcome, restoredClash } = await undoAndCheck();
      return Response.json({ error: verifyFailedMessage(outcome, restoredClash) }, { status: 503 });
    }
    // The earlier check rejected every entry that already existed, so any overlap found now is concurrent.
    // Both racing writers may see each other and both yield: safe, the user simply saves again.
    const clashed = entries.filter((entry) =>
      conflictingEntries(verified.staffUnavailability, entry.staff, { startDate, endDate }, entry.id).length > 0);
    if (clashed.length > 0) {
      const { outcome, restoredClash } = await undoAndCheck();
      return Response.json(
        { error: clashMessage(clashed.map((entry) => entry.staff), outcome, restoredClash) },
        { status: outcome === "failed" ? 500 : 409 },
      );
    }
    return Response.json({
      entries: entries.map((entry) => ({ id: entry.id, staff: entry.staff, startDate: entry.startDate, endDate: entry.endDate, note: entry.note })),
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
