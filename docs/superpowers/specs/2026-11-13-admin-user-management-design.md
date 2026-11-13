# Admin: จัดการอีเมลผู้ใช้ + แสดง "ลงโดย" (design)

สถานะ: เจ้าของอนุมัติแล้ว 2026-11-13 พร้อมสั่งดำเนินต่อจนถึง deploy (subagent-driven, Opus). ขนาด: โปรเจกต์เล็ก-กลาง (แตะ auth).

## Intent / why
ตอนนี้เข้าได้อีเมลเดียว (hnbcmu@gmail.com, hardcode ใน `auth.ts`). เจ้าของต้องการให้ nansurg7@gmail.com เป็น Admin เพิ่ม/ลบ gmail ที่เข้าใช้ได้ ปรับ role (user/admin) และสถานะ active/inactive (ปิดชั่วคราวโดยอีเมลยังอยู่) — และ **อยากรู้ว่าใครเป็นคนลงคิวแต่ละเคส**.

## Goals
1. ที่เก็บรายชื่อ `{email, role: user|admin, active}` ใน Vercel Blob (JSON ส่วนตัว, store ใหม่ของแอปนี้). Seed: nansurg7=admin, hnbcmu=user active.
2. สิทธิ์เข้าใช้ = อีเมลอยู่ในรายชื่อ + active (+ email_verified จาก Google เหมือนเดิม). ตรวจที่: Auth.js `signIn` callback, `authorized`, หน้าแรก/หน้า sign-in, และจุดรวมของ API (`authorizedAccessToken` ใน app/lib/calendar.ts, `/api/presence`). ตรวจซ้ำกับรายชื่อทุก request (cache ในหน่วยความจำ ≤30 วินาที) เพื่อให้ inactive/ลบมีผลกับคนที่ล็อกอินค้างอยู่ภายใน ~30 วินาที.
3. หน้า/แท็บ Admin (เห็นเฉพาะ role=admin; API ฝั่งเซิร์ฟเวอร์บังคับสิทธิ์เองด้วย): ดูรายชื่อ, เพิ่มอีเมล (ตรวจรูปแบบ gmail, ไม่ซ้ำ, ตัวพิมพ์เล็ก), ลบ, เปลี่ยน role, สลับ active/inactive; ยืนยันก่อนลบ; ข้อความไทยเหมือนส่วนอื่น.
4. "ลงโดย": `bookedByEmail` มาจาก session ของผู้ลงคิว (แทน AUTHORIZED_EMAIL คงที่ ที่ app/api/schedule/route.ts); แสดงใน CaseDetailDialog (บรรทัด "ลงโดย"). เคสเก่าแสดง hnbcmu เหมือนที่เก็บไว้.
5. `createdBy/updatedBy` ของวันปิดรับคิว / OR Extra / วันไม่ว่างอาจารย์ ใช้อีเมลผู้ทำจริง (ถ้าแก้ง่าย) — ไม่ใช่เงื่อนไขของงานนี้.

## Non-goals / anti-goals
- ไม่ทำ permission ละเอียดต่อฟีเจอร์ (user ลงคิว/ย้าย/ลบได้เท่า admin), ไม่ทำประวัติการแก้รายชื่อ, ไม่ย้ายข้อมูลปฏิทิน, ไม่เก็บรหัสผ่าน.
- ห้ามทำให้ hnbcmu@gmail.com เข้าไม่ได้หลัง deploy; ห้ามให้ใครล็อก admin หลักออก.

## Constraints
- Google Calendar ยังเข้าผ่าน server token (`GOOGLE_REFRESH_TOKEN`) เหมือนเดิม; ตัวแปรความลับ Blob ตั้งบน Vercel เท่านั้น ห้ามเขียนลง repo.
- Next.js เวอร์ชันนี้มี breaking changes: อ่าน `node_modules/next/dist/docs/` ก่อนเขียนโค้ด (AGENTS.md).
- ตรวจก่อนเสร็จ: `npm test`, `npx tsc --noEmit`, `npx eslint auth.ts app scripts tests`.

## Approaches
A) event พิเศษใน Google Calendar — รกปฏิทินจริง/ใครเปิดปฏิทินก็แก้ได้ (ไม่เลือก). B) Vercel Blob JSON (เลือก โดยเจ้าของ). C) env var — ไม่มี UI (ตัดทิ้ง).

## Calls ของ Claude (เจ้าของแก้ได้)
- nansurg7@gmail.com = admin ถาวรในโค้ด: ลบ/ลดสิทธิ์/ปิดไม่ได้ และเข้าได้แม้ Blob ล่ม; คนอื่นถ้าอ่าน Blob ไม่ได้ = เข้าไม่ได้ (fail closed).
- admin ลบ/ลดสิทธิ์/ปิดตัวเองไม่ได้ และห้ามเหลือ admin active น้อยกว่า 1.
- hnbcmu seed เป็น user (ไม่ใช่ admin) active.
- เจ้าของสั่ง: รับ gmail และโดเมนอื่นด้วย (เช่น cmu.ac.th) — ตรวจแค่รูปแบบอีเมลที่ถูกต้อง; การเข้าสู่ระบบยังผ่าน Google ต้อง email_verified. (หมายเหตุ: ต้องเป็นบัญชี Google ที่ใช้อีเมลนั้นล็อกอินได้.)
- การเขียน Blob แบบอ่าน-แก้-เขียนทั้งไฟล์ (มี admin คนเดียวเป็นหลัก) พร้อมตรวจ etag ถ้า SDK รองรับ.
- วิธีทำ: subagent-driven; ผู้ implement/รีวิวทุก task ใช้ Opus; รีวิวทั้ง branch ก่อน push.

## ที่ต้องทำบน Vercel (ก่อน deploy)
สร้าง Blob store (Claude สร้างผ่าน Vercel MCP ได้) และผูกตัวแปรกับโปรเจกต์ operative-schedule; seed ไฟล์รายชื่อก่อนเปิดใช้โค้ดใหม่.

## แก้ไขหลังอนุมัติ (บันทึกการตัดสินใจของ Claude)
- Seed อัตโนมัติเฉพาะเมื่อไฟล์รายชื่อ "ไม่พบ" (404) ไม่ใช่เมื่อเกิด error → กัน hnbcmu ถูกล็อกตอน deploy; ลำดับ deploy: สร้าง Blob store + ผูกตัวแปรกับโปรเจกต์ก่อน แล้วค่อย merge.
- Blob ใช้โหมด private ถ้า SDK รองรับ (รายชื่ออีเมลไม่ควรเป็นสาธารณะ).
- หน้า Admin = route `/admin` แยก (server component ตรวจ admin) + ลิงก์ในเมนูเฉพาะ admin; ไม่เพิ่มแท็บล่าง.
