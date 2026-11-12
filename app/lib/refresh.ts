export const REFRESH_THROTTLE_MS = 60_000;
export const REFRESH_INTERVAL_MS = 300_000;
export const FORM_IDLE_MS = 180_000;
export const STALE_AFTER_MS = 600_000;

export type RefreshGate = {
  now: number;
  lastLoadedAt: number | null;
  inFlight: boolean;
  busy: boolean;
  dialogOpen: boolean;
  lastFormEditAt: number | null;
};

export function shouldRefreshQuietly(gate: RefreshGate): boolean {
  if (gate.inFlight || gate.busy || gate.dialogOpen) return false;
  if (gate.lastLoadedAt !== null && gate.now - gate.lastLoadedAt < REFRESH_THROTTLE_MS) return false;
  if (gate.lastFormEditAt !== null && gate.now - gate.lastFormEditAt < FORM_IDLE_MS) return false;
  return true;
}

export type Freshness = { tone: "ok" | "stale" | "failed"; text: string };

const clock = new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

export function freshnessLabel(now: number, lastSyncedAt: number, importedCount: number, failed: boolean): Freshness {
  const time = clock.format(lastSyncedAt);
  if (failed) return { tone: "failed", text: `เชื่อมต่อไม่ได้ · ข้อมูลล่าสุดเมื่อ ${time} น.` };
  const minutes = Math.floor((now - lastSyncedAt) / 60_000);
  if (now - lastSyncedAt > STALE_AFTER_MS) {
    return { tone: "stale", text: `อัปเดตเมื่อ ${minutes} นาทีที่แล้ว · ข้อมูลเดิม ${importedCount} เคส` };
  }
  return { tone: "ok", text: `อัปเดตล่าสุด ${time} น. · ข้อมูลเดิม ${importedCount} เคส` };
}
