import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { deviceStatus } from '../db/schema.js';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';

const DEVICE_ID = 'esp32-s2-coop';
const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000;

// Used only to debounce broadcasts — not authoritative for online status.
let lastBroadcastOnline: boolean | null = null;

type DiagFields = Partial<{
  rssi: number;
  voltageV: number;
  currentMa: number;
  tempC: number;
  uptimeS: number;
}>;

export async function noteEsp32Contact(fields?: DiagFields): Promise<void> {
  const now = new Date();
  // Only forward diag fields actually provided. HTTP polls (no fields)
  // must not clobber the rssi/voltage/etc. snapshot from the last MQTT
  // telemetry message — those are sampled every 60s, polls fire ~constantly.
  const diag = {
    ...(fields?.rssi !== undefined && { rssi: fields.rssi }),
    ...(fields?.voltageV !== undefined && { voltageV: fields.voltageV }),
    ...(fields?.currentMa !== undefined && { currentMa: fields.currentMa }),
    ...(fields?.tempC !== undefined && { tempC: fields.tempC }),
    ...(fields?.uptimeS !== undefined && { uptimeS: fields.uptimeS }),
  };
  await db
    .insert(deviceStatus)
    .values({ deviceId: DEVICE_ID, lastSeen: now, updatedAt: now, ...diag })
    .onConflictDoUpdate({
      target: deviceStatus.deviceId,
      set: { lastSeen: now, updatedAt: now, ...diag },
    });
}

export async function markEsp32Online(fields?: DiagFields): Promise<void> {
  await noteEsp32Contact(fields);
  const nowIso = new Date().toISOString();
  if (lastBroadcastOnline !== false && lastBroadcastOnline !== null) return;
  lastBroadcastOnline = true;
  wsBroadcaster.broadcast('esp32:status', { online: true, lastSeen: nowIso });
  wsBroadcaster.broadcast('system:alert', {
    text: 'ESP32 controller back online.',
    severity: 'info',
    category: 'ESP32_OFFLINE',
    isPinned: false,
  });
}

export async function getEsp32Status(): Promise<{ online: boolean; lastSeen: string | null }> {
  const [row] = await db
    .select({ lastSeen: deviceStatus.lastSeen })
    .from(deviceStatus)
    .where(eq(deviceStatus.deviceId, DEVICE_ID));

  if (!row) return { online: false, lastSeen: null };

  const ageMs = Date.now() - row.lastSeen.getTime();
  const online = ageMs < OFFLINE_THRESHOLD_MS;
  return { online, lastSeen: row.lastSeen.toISOString() };
}

export async function esp32HeartbeatJob(): Promise<void> {
  const [row] = await db
    .select({ lastSeen: deviceStatus.lastSeen })
    .from(deviceStatus)
    .where(eq(deviceStatus.deviceId, DEVICE_ID));

  const lastSeen = row?.lastSeen ?? null;
  const ageMs = lastSeen ? Date.now() - lastSeen.getTime() : Infinity;
  const online = lastSeen !== null && ageMs < OFFLINE_THRESHOLD_MS;

  if (lastBroadcastOnline === online) return;
  lastBroadcastOnline = online;

  wsBroadcaster.broadcast('esp32:status', {
    online,
    lastSeen: lastSeen?.toISOString() ?? null,
  });

  if (!online) {
    wsBroadcaster.broadcast('system:alert', {
      text: 'ESP32 controller offline — no heartbeat for 15+ minutes.',
      severity: 'error',
      category: 'ESP32_OFFLINE',
      isPinned: true,
    });
  } else {
    wsBroadcaster.broadcast('system:alert', {
      text: 'ESP32 controller back online.',
      severity: 'info',
      category: 'ESP32_OFFLINE',
      isPinned: false,
    });
  }
}
