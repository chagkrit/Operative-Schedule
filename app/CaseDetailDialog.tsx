import type { RefObject } from "react";

export type CaseDetail = {
  roomLabel: string;
  slotNo: number;
  when: string;
  operation: string;
  patientName: string;
  hn: string;
  diagnosis: string;
  isCancer: boolean;
  neoadjuvantTreatment: boolean | null;
  staff: string;
  duration: string;
  note: string;
  bookedBy: string;
  clash: string;
  synced: boolean;
};

type CaseDetailDialogProps = {
  detail: CaseDetail;
  closeRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onManage: () => void;
};

function neoadjuvantText(value: boolean | null) {
  return value === true ? "ได้รับ" : value === false ? "ไม่ได้รับ" : "ไม่ระบุ";
}

// Read-only view of one case, opened by tapping it in the queue list or the month view.
// Changes still go through the search screen's existing move / edit / delete flow.
export default function CaseDetailDialog({ detail, closeRef, onClose, onManage }: CaseDetailDialogProps) {
  const rows: [string, string][] = [
    ["ผ่าตัด", detail.operation || "ไม่ระบุ"],
    ["ผู้ป่วย", detail.patientName || "ไม่ระบุ"],
    ["HN", detail.hn || "ไม่ระบุ"],
    ["Diagnosis", `${detail.diagnosis || "ไม่ระบุ"}${detail.isCancer ? " · Cancer" : ""}`],
    ["Neoadjuvant", neoadjuvantText(detail.neoadjuvantTreatment)],
    ["Staff", detail.staff],
    ["ระยะเวลา", detail.duration || "ไม่ระบุ"],
    ["หมายเหตุ", detail.note || "-"],
    ["ลงโดย", detail.bookedBy || "ไม่ระบุ"],
  ];
  return (
    <div className="queue-conflict-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="queue-conflict-dialog case-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="case-detail-title">
        <div className="case-detail-heading">
          <span className={`case-detail-slot ${detail.isCancer ? "cancer" : ""}`}>#{detail.slotNo}</span>
          <div>
            <h3 id="case-detail-title">{detail.roomLabel} #{detail.slotNo}</h3>
            <p>{detail.when}</p>
          </div>
        </div>
        <dl className="case-detail-list">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {detail.clash && <p className="warning-line">{detail.clash}</p>}
        <small className="case-detail-sync">{detail.synced ? "● บันทึกใน Google Calendar แล้ว" : "● ยังไม่ซิงก์กับ Google Calendar"}</small>
        <div className="case-detail-actions">
          <button ref={closeRef} type="button" onClick={onClose}>ปิด</button>
          <button type="button" onClick={onManage}>สลับวัน / แก้ไข / ลบ</button>
        </div>
      </section>
    </div>
  );
}
