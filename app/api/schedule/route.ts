import { AUTHORIZED_EMAIL } from "../../../auth";
import { createBookingEvent, deleteBookingEvent, listRecentMoves } from "../../lib/calendar";
import { destinationError, getSchedule, nextAvailableSlot } from "../../lib/queue";
import { addDays, dateOnly, diagnosisIsCancer, endOfRollingHorizon, isNormalDay, isStaffOption, orderedStaffMembers } from "../../lib/schedule";

function statusFor(error: unknown) {
  const message = error instanceof Error ? error.message : "เกิดข้อผิดพลาด";
  if (message.includes("เข้าสู่ระบบ") || message.includes("สิทธิ์ Google")) return 401;
  if (message.includes("พร้อมกัน")) return 409;
  return 500;
}

export async function GET(request: Request) {
  try {
    const today = dateOnly();
    const horizonEnd = endOfRollingHorizon(today);
    const [{ days, bookings, closures }, recentMoves] = await Promise.all([
      getSchedule(request, today, horizonEnd),
      listRecentMoves(request, addDays(today, -730), horizonEnd),
    ]);
    return Response.json({
      days,
      closures,
      horizonStart: today,
      horizonEnd,
      bookings: bookings
        .sort((a, b) => a.scheduleDate.localeCompare(b.scheduleDate) || a.slotNo - b.slotNo)
        .map((booking) => ({
          id: booking.id,
          scheduleDate: booking.scheduleDate,
          queueType: booking.queueType,
          slotNo: booking.slotNo,
          diagnosis: booking.diagnosis,
          isCancer: booking.isCancer,
          neoadjuvantTreatment: booking.neoadjuvantTreatment,
          hn: booking.hn,
          patientName: `${booking.firstName} ${booking.lastName}`,
          operation: booking.operation,
          note: booking.note,
          staffMembers: booking.staffMembers,
          calendarSyncStatus: "synced" as const,
        })),
      recentMoves: recentMoves.map((booking) => ({
        id: booking.id,
        hn: booking.hn,
        patientName: `${booking.firstName} ${booking.lastName}`,
        operation: booking.operation,
        fromDate: booking.lastMoveFrom,
        toDate: booking.lastMoveTo,
        movedAt: booking.lastMoveAt,
        moveCount: booking.moveCount,
      })),
      importedCount: bookings.filter((booking) => booking.importedFromCalendar).length,
      calendarConnected: true,
      calendarName: AUTHORIZED_EMAIL,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "โหลดข้อมูลไม่สำเร็จ" }, { status: statusFor(error) });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const diagnosis = String(payload.diagnosis || "").trim();
    const hn = String(payload.hn || "").trim();
    const firstName = String(payload.firstName || "").trim();
    const lastName = String(payload.lastName || "").trim();
    const phone = String(payload.phone || "").trim();
    const operation = String(payload.operation || "").trim();
    const note = String(payload.note || "").trim();
    const neoadjuvantTreatment = payload.neoadjuvantTreatment === true;
    const rawStaffMembers = payload.staffMembers;
    const submittedStaffMembers = Array.isArray(rawStaffMembers)
      ? rawStaffMembers.map((value) => typeof value === "string" ? value.trim() : "")
      : [];
    const staffMembers = orderedStaffMembers(submittedStaffMembers);
    const staffMemberSet = new Set<string>(staffMembers);
    const staffQueuePreference = String(payload.staffQueuePreference || "any").trim();
    const requestedDate = String(payload.requestedDate || "").trim();
    const requestedQueueType = String(payload.requestedQueueType || "").trim();
    const cancerSchedulingMode = String(payload.cancerSchedulingMode || "earliest").trim();
    const dateEntryMode = String(payload.dateEntryMode || "list").trim();
    const missing = [[diagnosis, "Diagnosis"], [hn, "HN"], [firstName, "ชื่อ"], [lastName, "สกุล"], [phone, "Tel"], [operation, "Operation"]]
      .filter(([value]) => !value).map(([, label]) => label);
    if (submittedStaffMembers.length === 0) missing.push("Staff");
    if (missing.length) return Response.json({ error: `กรุณากรอกข้อมูลให้ครบ: ${missing.join(", ")}` }, { status: 400 });
    if (note.length > 1000) return Response.json({ error: "หมายเหตุต้องมีความยาวไม่เกิน 1,000 ตัวอักษร" }, { status: 400 });
    if (submittedStaffMembers.some((staff) => !isStaffOption(staff))) return Response.json({ error: "กรุณาเลือก Staff จากรายชื่อ" }, { status: 400 });
    if (new Set(submittedStaffMembers).size !== submittedStaffMembers.length) return Response.json({ error: "กรุณาเลือก Staff แต่ละคนเพียงครั้งเดียว" }, { status: 400 });
    if (!["same_staff", "any"].includes(staffQueuePreference)) return Response.json({ error: "กรุณาเลือกเงื่อนไขห้องผ่าตัดตาม Staff" }, { status: 400 });
    if (!["list", "manual"].includes(dateEntryMode)) return Response.json({ error: "กรุณาเลือกวิธีระบุวันที่ผ่าตัด" }, { status: 400 });

    const isCancer = diagnosisIsCancer(diagnosis);
    const today = dateOnly();
    const horizonEnd = endOfRollingHorizon(today);
    if (requestedDate && (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) || requestedDate < today)) {
      return Response.json({ error: "กรุณาเลือกวันที่ผ่าตัดตั้งแต่วันนี้เป็นต้นไป" }, { status: 400 });
    }
    if (requestedDate && requestedDate > horizonEnd) {
      return Response.json({ error: `กรุณาเลือกวันที่ผ่าตัดไม่เกิน ${horizonEnd}` }, { status: 400 });
    }
    if (isCancer && !["earliest", "specific"].includes(cancerSchedulingMode)) return Response.json({ error: "กรุณาเลือกวิธีจัดคิว Cancer" }, { status: 400 });
    if (isCancer && cancerSchedulingMode === "specific" && (!requestedDate || !["OR17", "EXTRA"].includes(requestedQueueType))) {
      return Response.json({ error: "กรุณาเลือกวันที่และประเภทคิวสำหรับ Cancer" }, { status: 400 });
    }
    if (!isCancer && !requestedDate) return Response.json({ error: "กรุณาเลือกวันที่ผ่าตัด" }, { status: 400 });

    const hasSpecificDate = !isCancer || cancerSchedulingMode === "specific";
    const scheduleFrom = hasSpecificDate ? requestedDate : today;
    const scheduleTo = horizonEnd;
    const [requestedSchedule, dropdownSchedule] = await Promise.all([
      getSchedule(request, scheduleFrom, scheduleTo),
      dateEntryMode === "manual" && hasSpecificDate
        ? getSchedule(request, today, addDays(today, 120))
        : Promise.resolve(null),
    ]);
    const { days, bookings } = requestedSchedule;
    const staffDayKeys = new Set(
      bookings
        .filter((booking) => booking.staffMembers.some((member) => staffMemberSet.has(member)))
        .map((booking) => `${booking.scheduleDate}:${booking.queueType}`),
    );
    const matchesStaffPreference = (day: (typeof days)[number]) =>
      staffQueuePreference === "any" || staffDayKeys.has(`${day.date}:${day.queueType}`);
    const matchesClinicalRules = (day: (typeof days)[number]) => !destinationError({ isCancer }, day);
    let manualMinDate = "";
    if (dropdownSchedule) {
      const dropdownStaffDayKeys = new Set(
        dropdownSchedule.bookings
          .filter((booking) => booking.staffMembers.some((member) => staffMemberSet.has(member)))
          .map((booking) => `${booking.scheduleDate}:${booking.queueType}`),
      );
      const dropdownDays = dropdownSchedule.days.filter((day) => {
        if (!isCancer && day.queueType !== "OR17") return false;
        if (staffQueuePreference === "same_staff" && !dropdownStaffDayKeys.has(`${day.date}:${day.queueType}`)) return false;
        return !destinationError({ isCancer }, day);
      });
      const lastDropdownDate = dropdownDays.at(-1)?.date || dropdownSchedule.days.at(-1)?.date || today;
      manualMinDate = addDays(lastDropdownDate, 1);
    }
    const alternativeDays = days
      .filter((day) => {
        if (manualMinDate && day.date < manualMinDate) return false;
        if (day.date === requestedDate && day.queueType === (isCancer ? requestedQueueType : "OR17")) return false;
        if (!isCancer && day.queueType !== "OR17") return false;
        return matchesStaffPreference(day) && matchesClinicalRules(day);
      })
      .slice(0, 5)
      .map((day) => ({
        date: day.date,
        queueType: day.queueType,
        availableSlots: day.capacity - day.count,
      }));
    if (manualMinDate && requestedDate < manualMinDate) {
      return Response.json(
        {
          error: `ระบุวันเองได้ตั้งแต่ ${manualMinDate} เป็นต้นไป เพราะเป็นวันถัดจากคิวว่างสุดท้ายใน Drop-down`,
          suggestions: alternativeDays,
        },
        { status: 409 },
      );
    }
    const candidates = isCancer
      ? cancerSchedulingMode === "specific"
        ? days.filter((day) => day.date === requestedDate && day.queueType === requestedQueueType && matchesStaffPreference(day) && matchesClinicalRules(day))
        : days.filter((day) => matchesStaffPreference(day) && matchesClinicalRules(day))
      : days.filter((day) => day.date === requestedDate && day.queueType === "OR17" && matchesStaffPreference(day) && matchesClinicalRules(day));
    if (!candidates.length) {
      const selectedDay = days.find((day) => day.date === requestedDate && day.queueType === (isCancer ? requestedQueueType : "OR17"));
      const selectedDayError = hasSpecificDate ? destinationError({ isCancer }, selectedDay) : "";
      const error = staffQueuePreference === "same_staff" && selectedDay && !matchesStaffPreference(selectedDay)
        ? `ไม่พบคิวว่างที่ Staff ที่เลือกมีเคสอยู่แล้ว กรุณาเลือกห้องไหนก็ได้ที่ยังว่าง`
        : selectedDayError
          ? selectedDayError
        : isCancer && cancerSchedulingMode === "earliest"
          ? "ไม่พบคิวว่างในช่วง 12 เดือนข้างหน้า"
          : !isCancer && !isNormalDay(requestedDate)
            ? "เคสที่ไม่ใช่ Cancer เลือกได้เฉพาะคิวปกติ OR 17 วันอังคารหรือพฤหัสบดี"
            : "วันที่หรือประเภทคิวที่เลือกเต็ม หรือไม่ได้เปิดรับคิว";
      return Response.json({ error, suggestions: alternativeDays }, { status: 409 });
    }
    const selected = candidates[0];
    const invalidDestination = destinationError({ isCancer }, selected);
    if (invalidDestination) return Response.json({ error: invalidDestination, suggestions: alternativeDays }, { status: 409 });

    const slotNo = nextAvailableSlot(bookings, selected.date, selected.queueType, selected.capacity);
    const id = await createBookingEvent(request, {
      scheduleDate: selected.date,
      queuedDate: today,
      queueType: selected.queueType,
      slotNo,
      diagnosis,
      isCancer,
      neoadjuvantTreatment,
      hn,
      firstName,
      lastName,
      phone,
      operation,
      note,
      staffMembers,
      bookedByEmail: AUTHORIZED_EMAIL,
    });
    const verified = await getSchedule(request, selected.date, selected.date);
    const verifiedDay = verified.days.find((day) => day.date === selected.date && day.queueType === selected.queueType);
    if (!verifiedDay || verifiedDay.closed || verifiedDay.count > verifiedDay.capacity) {
      await deleteBookingEvent(request, id);
      return Response.json(
        { error: "มีผู้ลงคิวพร้อมกันและคิวเต็ม กรุณาเลือกวันใหม่หรือกดบันทึกอีกครั้ง", suggestions: alternativeDays },
        { status: 409 },
      );
    }
    return Response.json({ booking: { id, date: selected.date, queueType: selected.queueType, slotNo }, message: "บันทึกและเพิ่มใน Google Calendar แล้ว" }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ" }, { status: statusFor(error) });
  }
}
