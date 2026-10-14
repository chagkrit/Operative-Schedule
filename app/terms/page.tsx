import type { Metadata } from "next";
import LegalPage, { LEGAL_CONTACT_EMAIL } from "../LegalPage";

export const metadata: Metadata = { title: "ข้อกำหนดการใช้งาน | OR Queue" };

export default function TermsPage() {
  return (
    <LegalPage title="ข้อกำหนดการใช้งาน (Terms of Service)">
      <p>
        ข้อกำหนดนี้ใช้กับ OR Queue ระบบลงคิวผ่าตัด OR 17 และ OR Extra ของหน่วยศัลยกรรมเต้านมและต่อมไร้ท่อ
        (Breast &amp; Endocrine Surgery CMU) การเข้าสู่ระบบและใช้งานถือว่าท่านยอมรับข้อกำหนดนี้
      </p>

      <h2>1. ผู้มีสิทธิ์ใช้งาน</h2>
      <p>ระบบสำหรับเจ้าหน้าที่ของหน่วยที่ได้รับอนุญาตเท่านั้น และเข้าสู่ระบบได้ด้วยบัญชี Google ที่หน่วยกำหนด ห้ามแบ่งปันการเข้าถึงหรือพยายามเข้าถึงด้วยบัญชีอื่น</p>

      <h2>2. วัตถุประสงค์การใช้งาน</h2>
      <p>ใช้เพื่อจัดคิวผ่าตัดและดูตารางของหน่วยเท่านั้น ระบบเป็นเครื่องมือช่วยบริหารคิว ไม่ใช่ระบบเวชระเบียนและไม่ให้คำแนะนำทางการแพทย์ การตัดสินใจทางคลินิกเป็นหน้าที่ของแพทย์ผู้รักษา</p>

      <h2>3. ความรับผิดชอบของผู้ใช้</h2>
      <ul>
        <li>กรอกข้อมูลคิวให้ถูกต้อง ตรวจสอบ HN และวันที่ก่อนบันทึก</li>
        <li>กรอกข้อมูลผู้ป่วยเท่าที่จำเป็นต่อการจัดคิว และรักษาความลับของข้อมูล</li>
        <li>ไม่ใช้ระบบในทางที่ผิดกฎหมาย รบกวนการทำงาน หรือพยายามหลบเลี่ยงการยืนยันตัวตน</li>
        <li>ออกจากระบบเมื่อใช้งานบนอุปกรณ์ที่ไม่ใช่ของตนเอง</li>
      </ul>

      <h2>4. ข้อมูลและ Google Calendar</h2>
      <p>ข้อมูลคิวถูกเก็บใน Google Calendar ของหน่วย การจัดการข้อมูลเป็นไปตาม <a href="/privacy">นโยบายความเป็นส่วนตัว</a> ของระบบ</p>

      <h2>5. ความพร้อมใช้งานและข้อจำกัดความรับผิด</h2>
      <p>
        ระบบให้บริการตามสภาพที่เป็นอยู่ อาจหยุดชะงักเมื่อ Google Calendar หรือผู้ให้บริการโฮสต์มีปัญหา
        หรือเมื่อการเชื่อมต่อ Google หมดอายุและต้องให้ผู้ดูแลระบบต่ออายุ ผู้ใช้ควรตรวจสอบตารางคิวสำคัญกับ Google Calendar
        หรือช่องทางสำรองของหน่วยเมื่อระบบแจ้งว่าอ่านข้อมูลไม่สำเร็จ ผู้ดูแลระบบไม่รับผิดชอบความเสียหายที่เกิดจากการกรอกข้อมูลผิดหรือระบบใช้งานไม่ได้ ในขอบเขตที่กฎหมายอนุญาต
      </p>

      <h2>6. การระงับการใช้งานและการเปลี่ยนแปลง</h2>
      <p>ผู้ดูแลระบบอาจระงับการเข้าถึงหากพบการใช้งานที่ไม่เหมาะสม และอาจปรับข้อกำหนดนี้ได้ โดยแสดงวันที่ปรับปรุงล่าสุดไว้ในหน้านี้</p>

      <h2>7. ติดต่อ</h2>
      <p><a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a></p>

      <section lang="en" className="legal-en">
        <h2>Summary (English)</h2>
        <p>
          OR Queue is an internal tool of the Breast &amp; Endocrine Surgery unit for scheduling operating-room cases. Access
          is limited to the authorized staff account. It supports scheduling only and is not a medical record or a source of
          clinical advice. Users must enter accurate data, keep patient information confidential, and not misuse the service.
          The service is provided as is, and may be unavailable if Google Calendar or hosting is down. See the Privacy
          Policy for how data is handled. Contact: {LEGAL_CONTACT_EMAIL}.
        </p>
      </section>
    </LegalPage>
  );
}
