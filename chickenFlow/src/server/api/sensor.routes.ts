import { Router } from 'express';
import { getEsp32Status } from '../jobs/esp32-heartbeat.job.js';

export const sensorRouter = Router();

// ESP32 online badge on the frontend. All other device-facing HTTP routes
// (sensor/door-event/obstruction-check/latest) are dead — the firmware is
// MQTT-only, see docs/mqtt-schema.md and mqtt-bridge.service.ts.
sensorRouter.get('/status', async (_req, res, next) => {
  try {
    res.json(await getEsp32Status());
  } catch (err) {
    next(err);
  }
});
