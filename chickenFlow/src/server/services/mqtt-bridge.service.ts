import mqtt, { type MqttClient } from 'mqtt';
import { sql, eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  chickenCounts,
  doorEvents,
  settings,
} from '../db/schema.js';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import { markEsp32Online } from '../jobs/esp32-heartbeat.job.js';
import { localDate, tzOffsetMinutes } from '../util/local-date.js';

// ─────────────────────────────────────────────────────────────────────────────
// ChickenFlow MQTT bridge
//
// Backend ↔ ESP32 contract lives in chickenFlow/docs/mqtt-schema.md. Keep that
// doc, this file, and esp32-firmware/.../config.h in lock-step.
// ─────────────────────────────────────────────────────────────────────────────

const MQTT_URL = process.env['MQTT_URL'] ?? 'mqtt://mosquitto.hydroflow.svc.cluster.local:1883';

const T_TELEMETRY = 'coop/telemetry';
const T_COUNT = 'coop/count';
const T_DOOR_STATUS = 'coop/door/status';
const T_DOOR_CMD = 'coop/door/cmd';
const T_CONFIG = 'coop/config';

let client: MqttClient | null = null;

export function startMqttBridge(): void {
  if (client) return;

  console.log(`[mqtt] connecting to ${MQTT_URL}`);
  client = mqtt.connect(MQTT_URL, {
    clientId: `chickenflow-backend-${Math.random().toString(16).slice(2, 8)}`,
    keepalive: 30,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
  });

  client.on('connect', () => {
    console.log('[mqtt] connected');
    client?.subscribe(
      {
        [T_TELEMETRY]: { qos: 0 },
        [T_COUNT]: { qos: 1 },
        [T_DOOR_STATUS]: { qos: 1 },
      },
      (err) => {
        if (err) console.error('[mqtt] subscribe failed:', err);
        else console.log(`[mqtt] subscribed: ${T_TELEMETRY}, ${T_COUNT}, ${T_DOOR_STATUS}`);
      },
    );
    void publishConfigRetained();
  });

  client.on('reconnect', () => console.log('[mqtt] reconnecting…'));
  client.on('close', () => console.log('[mqtt] connection closed'));
  client.on('error', (err) => console.error('[mqtt] error:', err.message));

  client.on('message', (topic, buf) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(buf.toString()) as Record<string, unknown>;
    } catch {
      console.warn(`[mqtt] dropping malformed JSON on ${topic}`);
      return;
    }
    void dispatch(topic, payload).catch((err) => {
      console.error(`[mqtt] handler error on ${topic}:`, (err as Error).message);
    });
  });
}

async function dispatch(topic: string, payload: Record<string, unknown>): Promise<void> {
  switch (topic) {
    case T_TELEMETRY:
      return handleTelemetry(payload);
    case T_COUNT:
      return handleCount(payload);
    case T_DOOR_STATUS:
      return handleDoorStatus(payload);
    default:
      console.warn(`[mqtt] unknown topic ${topic}`);
  }
}

// ── coop/telemetry ───────────────────────────────────────────────────────────
async function handleTelemetry(p: Record<string, unknown>): Promise<void> {
  const fields = {
    rssi: typeof p['rssi'] === 'number' ? p['rssi'] : undefined,
    voltageV: typeof p['v'] === 'number' ? p['v'] : undefined,
    currentMa: typeof p['ma'] === 'number' ? p['ma'] : undefined,
    tempC: typeof p['temp'] === 'number' ? p['temp'] : undefined,
    uptimeS: typeof p['uptime_s'] === 'number' ? p['uptime_s'] : undefined,
  };
  await markEsp32Online(fields);

  const todayStr = localDate();
  const [countRow] = await db
    .select({ netInside: chickenCounts.netInside })
    .from(chickenCounts)
    .where(eq(chickenCounts.date, todayStr));
  const chickensInside = countRow?.netInside ?? 0;

  const [lastDoor] = await db
    .select({ toState: doorEvents.toState })
    .from(doorEvents)
    .orderBy(desc(doorEvents.createdAt))
    .limit(1);
  const doorState = lastDoor?.toState ?? 'CLOSED';

  wsBroadcaster.broadcast('sensor:reading', {
    topSensorTriggered: false,
    irTriggered: false,
    irATriggered: false,
    irBTriggered: false,
    chickensInside,
    doorState,
    telemetry: p,
  });
}

// ── coop/count ───────────────────────────────────────────────────────────────
async function handleCount(p: Record<string, unknown>): Promise<void> {
  const dir = p['dir'];
  if (dir !== 'IN' && dir !== 'OUT') {
    console.warn(`[mqtt] dropping count with invalid dir=${String(dir)}`);
    return;
  }

  const eventInstant = typeof p['ts'] === 'string' ? new Date(p['ts']) : new Date();
  const dateKey = localDate(isNaN(eventInstant.getTime()) ? new Date() : eventInstant);

  const isEntry = dir === 'IN';
  const inDelta = isEntry ? 1 : 0;
  const outDelta = isEntry ? 0 : 1;
  const netDelta = isEntry ? 1 : -1;

  // Atomic per-event increment — concurrent IRs cannot corrupt the tally.
  await db.execute(sql`
    INSERT INTO chicken_counts (date, total_in, total_out, net_inside)
    VALUES (${dateKey}, ${inDelta}, ${outDelta}, ${netDelta})
    ON CONFLICT (date) DO UPDATE SET
      total_in   = chicken_counts.total_in   + EXCLUDED.total_in,
      total_out  = chicken_counts.total_out  + EXCLUDED.total_out,
      net_inside = chicken_counts.net_inside + EXCLUDED.net_inside,
      updated_at = NOW()
  `);

  const [row] = await db
    .select()
    .from(chickenCounts)
    .where(eq(chickenCounts.date, dateKey));

  wsBroadcaster.broadcast('sensor:reading', {
    chickensInside: row?.netInside ?? netDelta,
    irTriggered: true,
    irATriggered: isEntry,
    irBTriggered: !isEntry,
    topSensorTriggered: false,
    doorState: undefined,
    count: { dir, totalIn: row?.totalIn, totalOut: row?.totalOut },
  });
}

// ── coop/door/status ─────────────────────────────────────────────────────────
async function handleDoorStatus(p: Record<string, unknown>): Promise<void> {
  const toState = typeof p['state'] === 'string' ? p['state'] : null;
  if (!toState) {
    console.warn('[mqtt] dropping door/status without state field');
    return;
  }
  const fromState = typeof p['from_state'] === 'string' ? p['from_state'] : 'UNKNOWN';
  const trigger = typeof p['last_event'] === 'string' ? p['last_event'] : 'esp32';

  await db.insert(doorEvents).values({
    fromState,
    toState,
    trigger,
    isManual: trigger === 'manual',
  });

  wsBroadcaster.broadcast('door:state_changed', {
    fromState,
    toState,
    trigger,
  });
}

// ── Outbound: door commands ──────────────────────────────────────────────────
export function publishDoorCommand(
  action: 'OPEN' | 'CLOSE',
  trigger: string,
  force = false,
): void {
  if (!client || !client.connected) {
    console.warn('[mqtt] cannot publish door cmd — client not connected');
    return;
  }
  const payload = JSON.stringify({
    action,
    force,
    trigger,
    req_id: Date.now().toString(),
  });
  client.publish(T_DOOR_CMD, payload, { qos: 1 }, (err) => {
    if (err) console.error('[mqtt] door cmd publish failed:', err.message);
  });
}

// ── Outbound: retained config ────────────────────────────────────────────────
export async function publishConfigRetained(): Promise<void> {
  if (!client || !client.connected) return;

  const [cfg] = await db.select().from(settings).where(eq(settings.id, 1));

  if (cfg?.locationLat == null || cfg?.locationLon == null) {
    console.log('[mqtt] cannot publish coop/config — settings.locationLat / locationLon not set');
    return;
  }

  const payload = JSON.stringify({
    lat: cfg.locationLat,
    lon: cfg.locationLon,
    tz_offset_min: tzOffsetMinutes(),
    solar_nudge_min: 0,
    travel_ms_watchdog: 15000,
  });
  client.publish(T_CONFIG, payload, { qos: 1, retain: true }, (err) => {
    if (err) console.error('[mqtt] config publish failed:', err.message);
    else console.log('[mqtt] retained coop/config published');
  });
}
