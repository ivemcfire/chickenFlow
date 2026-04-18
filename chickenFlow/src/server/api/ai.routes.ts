import { Router } from 'express';
import { db } from '../db/index.js';
import { aiAnalysisLog } from '../db/schema.js';
import { desc } from 'drizzle-orm';
import { analyzeCoopTelemetry } from '../services/ollama.service.js';
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
      contextNote: body.contextNote,
      currentTimeLocal: new Date().toLocaleTimeString(),
    });

    res.json(result);
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
