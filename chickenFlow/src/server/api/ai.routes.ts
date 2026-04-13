import { Router } from 'express';
import { db } from '../db/index.js';
import { aiAnalysisLog, cameraCaptures, doorEvents, sensorReadings } from '../db/schema.js';
import { desc } from 'drizzle-orm';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { analyzeCoopTelemetry, analyzeCapture, fetchCamSnapshot } from '../services/claude.service.js';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import type { AiAnalyzeRequest } from './types.js';

export const aiRouter = Router();

const capturesDir = process.env['CAPTURES_DIR'] ?? join(process.cwd(), 'data', 'captures');

aiRouter.post('/analyze', async (req, res, next) => {
  try {
    const body = req.body as AiAnalyzeRequest;

    const result = await analyzeCoopTelemetry({
      doorState: body.doorState,
      chickensInside: body.chickensInside,
      totalChickens: body.totalChickens,
      weatherCode: body.weatherCode,
      tempMax: body.tempMax,
      weatherLock: body.weatherLock,
      serviceMode: body.serviceMode,
      obstructionDistance: body.obstructionDistance,
      contextNote: body.contextNote,
      currentTimeLocal: new Date().toLocaleTimeString(),
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── IP cam snapshot + vision analysis ────────────────────────────────────────
// Fetches a frame from cam01, stores it, and triggers async AI vision analysis.
aiRouter.post('/snapshot', async (req, res, next) => {
  try {
    const rawBuffer = await fetchCamSnapshot();

    // Resize to max 800px wide before saving
    const { data: resized, info } = await sharp(rawBuffer)
      .resize({ width: 800, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer({ resolveWithObject: true });

    const fileName = `${Date.now()}.jpg`;
    const filePath = join(capturesDir, fileName);
    writeFileSync(filePath, resized);

    // Context snapshot
    const [latestDoor] = await db.select({ toState: doorEvents.toState })
      .from(doorEvents).orderBy(desc(doorEvents.createdAt)).limit(1);
    const [latestSensor] = await db.select({ chickensInside: sensorReadings.chickensInside })
      .from(sensorReadings).orderBy(desc(sensorReadings.createdAt)).limit(1);

    const [captureRow] = await db.insert(cameraCaptures).values({
      filePath: fileName,
      fileSizeBytes: info.size,
      widthPx: info.width,
      heightPx: info.height,
      doorStateAtCapture: latestDoor?.toState ?? 'UNKNOWN',
      chickensInsideAtCapture: latestSensor?.chickensInside,
    }).returning();

    wsBroadcaster.broadcast('camera:new_capture', {
      id: captureRow!.id,
      filePath: captureRow!.filePath,
      doorState: captureRow!.doorStateAtCapture,
    });

    // Async vision analysis — don't block the HTTP response
    analyzeCapture(captureRow!.id, resized).catch((err: Error) =>
      console.error('[Vision] Analysis failed for capture', captureRow!.id, err.message)
    );

    res.status(201).json({ id: captureRow!.id, ok: true });
  } catch (err) {
    next(err);
  }
});

aiRouter.get('/log', async (_req, res, next) => {
  try {
    const rows = await db.select().from(aiAnalysisLog)
      .orderBy(desc(aiAnalysisLog.createdAt))
      .limit(20);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
