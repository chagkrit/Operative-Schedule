import type { Metadata } from "next";
import LegalPage, { LEGAL_CONTACT_EMAIL } from "../LegalPage";

export const metadata: Metadata = { title: "นโยบายความเป็นส่วนตัว | OR Queue" };

export default function PrivacyPage() {
  return (
    <LegalPage title="นโยบายความเป็นส่วนตัว (Privacy Policy)">
      <p>
        OR Queue เป็นระบบภายในของหน่วยศัลยกรรมเต้านมและต่อมไร้ท่อ (Breast &amp; Endocrine Surgery CMU)
        ใช้ลงคิวผ่าตัด OR 17 และ OR Extra โดยเก็บข้อมูลคิวไว้ใน Google Calendar ของหน่วย
        เอกสารนี้อธิบายว่าระบบเข้าถึง ใช้ และเก็บข้อมูลอะไรบ้าง
      </p>

      <h2>1. ใครใช้ระบบได้</h2>
      <p>เฉพาะเจ้าหน้าที่ของหน่วยที่เข้าสู่ระบบด้วยบัญชี Google ที่หน่วยกำหนดไว้เพียงบัญชีเดียวเท่านั้น บัญชีอื่นจะถูกปฏิเสธ ระบบไม่เปิดให้ผู้ป่วยหรือบุคคลทั่วไปใช้งาน</p>

      <h2>2. ข้อมูลที่ระบบเข้าถึงและเก็บ</h2>
      <ul>
        <li><strong>ข้อมูลบัญชี Google:</strong> อีเมล ชื่อ และรูปโปรไฟล์ ใช้เพื่อยืนยันว่าเป็นบัญชีที่ได้รับอนุญาต เก็บในคุกกี้เซสชันของเบราว์เซอร์ที่เข้าสู่ระบบ</li>
        <li><strong>ข้อมูลคิวผ่าตัด:</strong> วันที่ผ่าตัด ห้องและลำดับคิว การวินิจฉัย การผ่าตัด รายชื่อ Staff หมายเหตุ รวมถึง HN ชื่อ นามสกุล และเบอร์โทรของผู้ป่วย ข้อมูลเหล่านี้ถูกบันทึกเป็นกิจกรรมใน Google Calendar ของหน่วย ระบบไม่มีฐานข้อมูลของตัวเอง</li>
        <li><strong>ข้อมูลบนอุปกรณ์:</strong> เบราว์เซอร์เก็บสถานะการดูการแจ้งเตือนสลับวัน (localStorage) และคุกกี้เซสชัน ระบบนับจำนวนอุปกรณ์ที่เปิดใช้งานอยู่ด้วยรหัสสุ่มที่เก็บในหน่วยความจำของเซิร์ฟเวอร์ชั่วคราวไม่เกิน 90 วินาที</li>
      </ul>

      <h2>3. สิทธิ์ Google Calendar ที่ขอ</h2>
      <p>
        ระบบใช้สิทธิ์ <code>https://www.googleapis.com/auth/calendar.events</code> ของ Google Calendar เพื่อ
        อ่านกิจกรรมในปฏิทินของหน่วยสำหรับแสดงตารางคิวและค้นหาเคส และสร้าง แก้ไข ย้ายวัน หรือลบกิจกรรมคิวผ่าตัดที่ระบบบันทึก
        ระบบไม่ใช้สิทธิ์นี้เพื่อวัตถุประสงค์อื่น
      </p>
      <p>
        การเข้าถึง Calendar ทำจากฝั่งเซิร์ฟเวอร์ของระบบด้วยการอนุญาตของบัญชีที่หน่วยกำหนด
        และไม่เปิดให้ข้อมูลใน Calendar ถูกอ่านโดยผู้ที่ไม่ได้เข้าสู่ระบบ
      </p>

      <h2>4. การใช้ข้อมูล</h2>
      <ul>
        <li>ใช้เฉพาะเพื่อจัดคิวผ่าตัดและตรวจสอบประวัติการสลับวันของหน่วย</li>
        <li>ไม่ขาย ไม่เปิดเผยเพื่อการโฆษณา และไม่ใช้เพื่อฝึกโมเดลปัญญาประดิษฐ์</li>
        <li>ไม่ส่งต่อให้บุคคลที่สาม ยกเว้นผู้ให้บริการโครงสร้างพื้นฐานที่จำเป็น ได้แก่ Google (Calendar และการเข้าสู่ระบบ) และ Vercel (โฮสต์เว็บแอป)</li>
        <li>เจ้าหน้าที่ไม่ควรกรอกข้อมูลผู้ป่วยเกินความจำเป็นต่อการจัดคิว</li>
      </ul>

      <h2>5. การใช้ข้อมูลจาก Google APIs</h2>
      <p>
        การใช้และการโอนข้อมูลที่ OR Queue ได้รับจาก Google APIs เป็นไปตาม{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener noreferrer">Google API Services User Data Policy</a>{" "}
        รวมถึงข้อกำหนด Limited Use
      </p>

      <h2>6. การเก็บรักษาและการลบข้อมูล</h2>
      <ul>
        <li>ข้อมูลคิวอยู่ใน Google Calendar จนกว่าผู้มีสิทธิ์จะลบเคสในระบบหรือลบกิจกรรมใน Calendar</li>
        <li>คุกกี้เซสชันหมดอายุตามอายุเซสชัน และลบได้โดยกด “ออกจากระบบ” หรือล้างคุกกี้ของเบราว์เซอร์</li>
        <li>ยกเลิกการอนุญาตให้ระบบเข้าถึง Google Calendar ได้ที่ <a href="https://myaccount.google.com/permissions" rel="noopener noreferrer">myaccount.google.com/permissions</a></li>
      </ul>

      <h2>7. ความปลอดภัย</h2>
      <p>การเชื่อมต่อใช้ HTTPS การเข้าถึงข้อมูลคิวต้องผ่านการเข้าสู่ระบบด้วยบัญชีที่ได้รับอนุญาตทุกครั้ง อย่างไรก็ตามไม่มีระบบใดปลอดภัยสมบูรณ์ หากพบการใช้งานที่ผิดปกติโปรดแจ้งผู้ดูแลระบบทันที</p>

      <h2>8. การเปลี่ยนแปลงนโยบาย</h2>
      <p>หน่วยอาจปรับนโยบายนี้เมื่อระบบเปลี่ยนแปลง วันที่ปรับปรุงล่าสุดแสดงไว้ด้านบนของหน้านี้</p>

      <h2>9. ติดต่อ</h2>
      <p>สอบถามหรือขอให้ลบข้อมูล: <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a></p>

      <section lang="en" className="legal-en">
        <h2>Summary (English)</h2>
        <p>
          OR Queue is an internal scheduling tool for the Breast &amp; Endocrine Surgery unit. Only one authorized Google
          account can sign in. The app reads and writes events in that account&apos;s Google Calendar (scope
          <code> calendar.events</code>) to show and manage the operating-room queue. Queue entries may include patient
          identifiers (hospital number, name, phone) and diagnosis; they are stored only in Google Calendar, the app has no
          database of its own. Data is used solely for scheduling, is not sold, shared for advertising, or used to train AI
          models, and is processed only by Google and Vercel (hosting). The app&apos;s use of information received from
          Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.
          Access can be revoked at myaccount.google.com/permissions. Contact: {LEGAL_CONTACT_EMAIL}.
        </p>
      </section>
    </LegalPage>
  );
}
