# Operative Schedule

ระบบลงคิวผ่าตัด Breast & Endocrine Surgery CMU สำหรับ OR 17 และ OR Extra โดยใช้ Google Calendar ของ `hnbcmu@gmail.com` เป็นแหล่งข้อมูลกลาง

## กติกาหลัก

- ผู้ใช้งานและผู้บันทึกคิวต้องเข้าสู่ระบบด้วย `hnbcmu@gmail.com` เท่านั้น
- OR 17 เปิดวันอังคารและพฤหัสบดี สูงสุด 4 เคสต่อวัน และต้องมี Cancer อย่างน้อย 1 เคส
- OR Extra เปิดเป็นรายวันในวันจันทร์หรือพฤหัสบดี และรับเฉพาะ Cancer
- Cancer เลือกคิวว่างเร็วที่สุดอัตโนมัติ หรือระบุวันเองได้
- บันทึกเคสและวัน Extra ลง Google Calendar ทันที
- ค้นหาเคสย้อนหลังจาก HN ชื่อ หรือสกุล แล้วสลับไปยังคิวที่ยังว่างได้
- เก็บการสลับวันไว้ในกิจกรรม Google Calendar และแสดง 10 เคสล่าสุดในหน้าเว็บ
- ผู้ดูแลเพิ่ม แก้ไข ค้นหา และลบวันปิดรับคิวได้จากแท็บ “วันปิดรับคิว” โดยปิดทั้ง OR 17 และ OR Extra
- หากวันที่ปิดมีคิวเดิม ระบบจะแสดงรายการให้ยืนยันและคงคิวเดิมไว้ แต่ห้ามสร้างหรือย้ายคิวใหม่เข้าวันนั้น
- เปิดปฏิทินและลงคิวได้ถึงสิ้นเดือนที่ห่างจากเดือนปัจจุบัน 12 เดือน โดยแสดงปี พ.ศ. และเก็บวันที่เป็น ISO ค.ศ.

## การใช้งานบนมือถือและแท็บเล็ต

บนหน้าจอกว้างไม่เกิน 1000px ระบบแสดงทีละหน้าจอ และมีแถบเมนูด้านล่าง 4 หน้า: **ตาราง** (`?tab=schedule`), **ลงคิว** (`?tab=book`), **ค้นหา** (`?tab=search`) และ **แจ้งเตือน** (`?tab=alerts`) ตัวเลขบนแจ้งเตือนคือการสลับวันที่ยังไม่ได้ดูบนเครื่องนี้ (เก็บใน localStorage ของเบราว์เซอร์) ส่วนปุ่ม Sync, Export และออกจากระบบอยู่ในปุ่ม "เมนู" ด้านบน หน้าจอเดสก์ท็อปแสดงทุกส่วนพร้อมกันเหมือนเดิม

## ตั้งค่า

สร้าง `.env.local` จาก `.env.example` แล้วกำหนด Google OAuth Web Client:

```bash
cp .env.example .env.local
npm install
npm run dev
```

Authorized redirect URI สำหรับเครื่องพัฒนา:

`http://localhost:3000/api/auth/callback/google`

สำหรับ Vercel ให้เพิ่ม URI ของโดเมนจริง:

`https://<your-domain>/api/auth/callback/google`

## การเชื่อม Google Calendar (token ฝั่งเซิร์ฟเวอร์)

เมื่อตั้ง `GOOGLE_REFRESH_TOKEN` เซิร์ฟเวอร์จะถือสิทธิ์เข้าถึง Calendar ของ `hnbcmu@gmail.com` เพียงชุดเดียวและต่ออายุเอง ทุกเครื่องใช้ร่วมกัน การเข้าสู่ระบบจึงใช้พิสูจน์ตัวตนเท่านั้น (ไม่ขอสิทธิ์ Calendar และไม่สร้าง refresh token ต่อเครื่องอีก) ถ้าไม่ได้ตั้งค่านี้ ระบบจะใช้ token ใน cookie ของแต่ละเครื่องเหมือนเดิม ซึ่งหมดอายุเป็นรายเครื่องได้ (`Token has been expired or revoked`)

ตั้งค่าครั้งแรก ตามลำดับ:

1. Google Cloud Console → Google Auth Platform → Audience: เปลี่ยน Publishing status เป็น **In production** ถ้ายังเป็น Testing refresh token จะหมดอายุทุก 7 วัน และทุกเครื่องจะพังพร้อมกัน (จะเห็นหน้า "Google hasn't verified this app" ให้เลือก Advanced → Continue ซึ่งใช้ได้กับบัญชีเจ้าของแอปเอง)
2. หยุด `npm run dev` แล้วรัน `node --env-file=.env.local scripts/get-calendar-refresh-token.mjs` เปิดลิงก์ที่แสดง เข้าสู่ระบบด้วย `hnbcmu@gmail.com` สคริปต์จะพิมพ์ refresh token ที่เทอร์มินัลเท่านั้น ไม่เขียนลงไฟล์
3. ตั้งค่าเป็น Environment Variable `GOOGLE_REFRESH_TOKEN` ใน Vercel (Production) แล้ว Redeploy ห้าม commit token
4. ทดสอบเปิดแอปจากเครื่องที่เคยขึ้น error

ถ้าแอปแสดง "การเชื่อม Google Calendar ของระบบหมดอายุหรือถูกเพิกถอน ผู้ดูแลระบบต้องต่ออายุ" (HTTP 503) ให้ทำข้อ 2–3 ซ้ำ การเข้าสู่ระบบใหม่บนเครื่องผู้ใช้ไม่ช่วยในโหมดนี้ สาเหตุที่พบบ่อยคือเปลี่ยนรหัสผ่านบัญชี Google, กดเพิกถอนสิทธิ์แอปที่ myaccount.google.com/permissions หรือ consent screen กลับไปเป็น Testing

## ตรวจสอบ

```bash
npm run lint
npm run build
npm test
```
