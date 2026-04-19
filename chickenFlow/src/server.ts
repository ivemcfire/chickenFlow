import 'dotenv/config';
import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiRouter } from './server/api/router.js';
import { attachWebSocketServer } from './server/ws/ws-server.js';
import { startScheduler } from './server/jobs/scheduler.js';
import { startMqttBridge } from './server/services/mqtt-bridge.service.js';
import { runMigrations } from './server/db/migrate.js';
import { requestLogger } from './server/middleware/request-logger.js';
import { errorHandler } from './server/middleware/error-handler.js';
import { db } from './server/db/index.js';
import { settings } from './server/db/schema.js';

const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = join(serverDistFolder, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(requestLogger);

// ── API routes (before static + Angular handler) ─────────────────────────────
app.use('/api', apiRouter);

// ── Static files ──────────────────────────────────────────────────────────────
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

// ── Angular SSR ───────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

// ── Error handler (must be last) ──────────────────────────────────────────────
app.use(errorHandler);

// ── Server startup ────────────────────────────────────────────────────────────
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] ?? 4000;

  // Run DB migrations before accepting traffic
  await runMigrations();

  // Ensure the single-row settings record exists
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  console.log('[startup] Settings row ensured');

  // Wrap Express in http.Server so WebSocket can share the port
  const httpServer = createServer(app);

  attachWebSocketServer(httpServer);
  startScheduler();
  startMqttBridge();

  httpServer.listen(port, () => {
    console.log(`ChickenFlow SSR + API listening on http://localhost:${port}`);
    console.log(`WebSocket endpoint: ws://localhost:${port}/ws`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
