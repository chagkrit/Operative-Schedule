import { auth, AUTHORIZED_EMAIL } from "../../../auth";

const PRESENCE_TTL_MS = 90_000;

declare global {
  var orQueueActiveDevices: Map<string, number> | undefined;
}

const activeDevices = globalThis.orQueueActiveDevices ??= new Map<string, number>();

function prunePresence(now = Date.now()) {
  for (const [deviceId, lastSeen] of activeDevices) {
    if (now - lastSeen > PRESENCE_TTL_MS) activeDevices.delete(deviceId);
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (session?.user?.email?.toLowerCase() !== AUTHORIZED_EMAIL) {
    return Response.json({ error: "ไม่ได้รับอนุญาต" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as { deviceId?: string; active?: boolean } | null;
  const deviceId = String(payload?.deviceId || "").trim();
  if (!/^[a-z0-9-]{16,80}$/i.test(deviceId)) {
    return Response.json({ error: "รหัสอุปกรณ์ไม่ถูกต้อง" }, { status: 400 });
  }

  prunePresence();
  if (payload?.active === false) activeDevices.delete(deviceId);
  else activeDevices.set(deviceId, Date.now());
  return Response.json({ activeDevices: Math.max(1, activeDevices.size), ttlSeconds: PRESENCE_TTL_MS / 1000 });
}

export const dynamic = "force-dynamic";
