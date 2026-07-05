import { Router } from 'express';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { settingsRouter } from './settings.routes.js';
import { doorEventsRouter } from './door-events.routes.js';
import { sensorRouter } from './sensor.routes.js';
import { cameraRouter } from './camera.routes.js';
import { messagesRouter } from './messages.routes.js';
import { weatherRouter } from './weather.routes.js';
import { aiRouter } from './ai.routes.js';
import { getMqttStatus } from '../services/mqtt-bridge.service.js';

export const apiRouter = Router();

// Health — DB readable + MQTT liveness (used for k3s readiness/liveness
// probes). A backend that can't reach the broker is deaf to the device and
// useless even if HTTP works, so a sustained MQTT outage fails the probe and
// k8s restarts the pod (observed 2026-07-04: wedged client, pod looked
// healthy for weeks). Grace period tolerates broker restarts.
const MQTT_UNHEALTHY_AFTER_MS = Number(process.env['MQTT_UNHEALTHY_AFTER_MS'] ?? 10 * 60 * 1000);
const startedAt = Date.now();

apiRouter.get('/health', async (_req, res) => {
  let dbOk = true;
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    dbOk = false;
  }

  const mqtt = getMqttStatus();
  const disconnectedSince = mqtt.lastConnectedAt
    ? new Date(mqtt.lastConnectedAt).getTime()
    : startedAt;
  const mqttOk = mqtt.connected || Date.now() - disconnectedSince < MQTT_UNHEALTHY_AFTER_MS;

  const ok = dbOk && mqttOk;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'error',
    db: dbOk,
    mqtt,
  });
});

apiRouter.use('/settings', settingsRouter);
apiRouter.use('/door', doorEventsRouter);
apiRouter.use('/esp32', sensorRouter);
apiRouter.use('/camera', cameraRouter);
apiRouter.use('/messages', messagesRouter);
apiRouter.use('/weather', weatherRouter);
apiRouter.use('/ai', aiRouter);
