# Operative Schedule

ระบบลงคิวผ่าตัด Breast & Endocrine Surgery CMU สำหรับ OR 17 และ OR Extra โดยใช้ Google Calendar ของ `hnbcmu@gmail.com` เป็นแหล่งข้อมูลกลาง

## กติกาหลัก

- ผู้ใช้งานและผู้บันทึกคิวต้องเข้าสู่ระบบด้วย `hnbcmu@gmail.com` เท่านั้น
- OR 17 เปิดวันอังคารและพฤหัสบดี สูงสุด 4 เคสต่อวัน และต้องมี Cancer อย่างน้อย 1 เคส
- OR Extra เปิดเป็นรายวันในวันจันทร์หรือพฤหัสบดี และรับเฉพาะ Cancer
- Cancer เลือกคิวว่างเร็วที่สุดอัตโนมัติ หรือระบุวันเองได้
- บันทึกเคสและวัน Extra ลง Google Calendar ทันที

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

## ตรวจสอบ

```bash
npm run lint
npm run build
npm test
```
