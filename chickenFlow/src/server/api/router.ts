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

export const apiRouter = Router();

// Health — checks DB is readable (used for k3s readiness/liveness probes)
apiRouter.get('/health', async (_req, res) => {
  try {
    await db.execute(sql`SELECT 1`);
    res.json({ status: 'ok', dbWritable: true });
  } catch {
    res.status(503).json({ status: 'error', dbWritable: false });
  }
});

apiRouter.use('/settings', settingsRouter);
apiRouter.use('/door', doorEventsRouter);
apiRouter.use('/esp32', sensorRouter);
apiRouter.use('/camera', cameraRouter);
apiRouter.use('/messages', messagesRouter);
apiRouter.use('/weather', weatherRouter);
apiRouter.use('/ai', aiRouter);
