const QUEUE_ROWS = [0, 1, 2, 3];
const CALENDAR_CELLS = Array.from({ length: 35 }, (_, index) => index);

export function QueueSkeleton() {
  return (
    <div className="orq-skeleton-queue" aria-busy="true">
      <span className="visually-hidden" role="status">กำลังโหลดคิว…</span>
      <div className="orq-skeleton orq-skeleton-day" aria-hidden="true" />
      {QUEUE_ROWS.map((row) => <div key={row} className="orq-skeleton orq-skeleton-row" aria-hidden="true" />)}
    </div>
  );
}

export function CalendarSkeleton() {
  return (
    <div className="orq-skeleton-calendar" aria-busy="true">
      <span className="visually-hidden" role="status">กำลังโหลดปฏิทินคิวผ่าตัด…</span>
      <div className="orq-skeleton-grid" aria-hidden="true">
        {CALENDAR_CELLS.map((cell) => <div key={cell} className="orq-skeleton orq-skeleton-cell" />)}
      </div>
    </div>
  );
}
