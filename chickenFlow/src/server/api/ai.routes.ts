import { Router } from 'express';
import { db } from '../db/index.js';
import { aiAnalysisLog, statusMessages } from '../db/schema.js';
import { desc } from 'drizzle-orm';
import { analyzeCoopTelemetry } from '../services/gemini.service.js';
import { assembleCoopTelemetry } from '../jobs/ai-analysis.job.js';
import { validate } from '../middleware/validate.js';
import { aiAnalyzeSchema, type AiAnalyzeBody } from './schemas.js';

export const aiRouter = Router();

aiRouter.post('/analyze', validate(aiAnalyzeSchema), async (req, res, next) => {
  try {
    const body = req.body as AiAnalyzeBody;

    // Telemetry (doorState, chickensInside, weather, …) is server-assembled
    // exactly like the hourly job — a client-supplied version would just be
    // UI animation state, not the real world. Only the free-text note is
    // taken from the request.
    const telemetry = await assembleCoopTelemetry(body.contextNote);
    const result = await analyzeCoopTelemetry(telemetry);

    if (result.analysisText) {
      await db.insert(statusMessages).values({
        text: result.analysisText,
        isWarning: result.isWarning,
        isError: false,
        isPinned: result.isWarning,
        category: result.isWarning ? 'AI_WARNING' : 'AI_REPORT',
      });
    }

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
