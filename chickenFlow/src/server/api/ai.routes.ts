import { Router } from 'express';
import { db } from '../db/index.js';
import { aiAnalysisLog, cameraCaptures, sensorReadings, weatherCache } from '../db/schema.js';
import { desc, sql } from 'drizzle-orm';
import { analyzeCoopTelemetry } from '../services/claude.service.js';
import type { AiAnalyzeRequest } from './types.js';

export const aiRouter = Router();

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

aiRouter.get('/log', (_req, res, next) => {
  try {
    const rows = db.select().from(aiAnalysisLog)
      .orderBy(desc(aiAnalysisLog.createdAt))
      .limit(20)
      .all();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
