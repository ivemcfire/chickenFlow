import { Router } from 'express';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { writeFileSync } from 'node:fs';
import { settingsRouter } from './settings.routes.js';
import { doorEventsRouter } from './door-events.routes.js';
import { sensorRouter } from './sensor.routes.js';
import { messagesRouter } from './messages.routes.js';
import { weatherRouter } from './weather.routes.js';
import { aiRouter } from './ai.routes.js';

export const apiRouter = Router();

// Health — checks DB is readable and writable (used for k3s readiness/liveness probes)
apiRouter.get('/health', (_req, res) => {
  try {
    db.run(sql`SELECT 1`);
    // Verify the PVC mount is writable with a small probe write
    const dbPath = process.env['DB_PATH'] ?? './chickenflow.db';
    writeFileSync(dbPath + '.probe', 'ok');
    res.json({ status: 'ok', dbWritable: true });
  } catch {
    res.status(503).json({ status: 'error', dbWritable: false });
  }
});

apiRouter.use('/settings', settingsRouter);
apiRouter.use('/door', doorEventsRouter);
apiRouter.use('/esp32', sensorRouter);
apiRouter.use('/sensor', sensorRouter);
apiRouter.use('/messages', messagesRouter);
apiRouter.use('/weather', weatherRouter);
apiRouter.use('/ai', aiRouter);
