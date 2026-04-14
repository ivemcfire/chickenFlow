import { db } from '../db/index.js';
import { sensorReadings } from '../db/schema.js';
import { desc } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';

const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000;

let lastKnownOnline: boolean | null = null;
let lastContactAt = 0;

export function noteEsp32Contact(): void {
  lastContactAt = Date.now();
}

export async function esp32HeartbeatJob(): Promise<void> {
  const [row] = await db.select({ createdAt: sensorReadings.createdAt })
    .from(sensorReadings)
    .orderBy(desc(sensorReadings.createdAt))
    .limit(1);

  const sensorTs = row?.createdAt ? new Date(row.createdAt).getTime() : 0;
  const lastSeen = Math.max(sensorTs, lastContactAt);
  const ageMs = Date.now() - lastSeen;
  const online = lastSeen > 0 && ageMs < OFFLINE_THRESHOLD_MS;

  if (lastKnownOnline === online) return;
  lastKnownOnline = online;

  wsBroadcaster.broadcast('esp32:status', {
    online,
    lastSeen: row?.createdAt ?? null,
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

export function getEsp32Status(): { online: boolean; lastSeen: string | null } {
  const lastSeen = lastContactAt > 0 ? new Date(lastContactAt).toISOString() : null;
  const online = lastContactAt > 0 && Date.now() - lastContactAt < OFFLINE_THRESHOLD_MS;
  return { online, lastSeen };
}

export function markEsp32Online(): void {
  noteEsp32Contact();
  if (lastKnownOnline === true) return;
  lastKnownOnline = true;
  wsBroadcaster.broadcast('esp32:status', { online: true, lastSeen: new Date().toISOString() });
  wsBroadcaster.broadcast('system:alert', {
    text: 'ESP32 controller back online.',
    severity: 'info',
    category: 'ESP32_OFFLINE',
    isPinned: false,
  });
}
