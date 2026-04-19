import { db } from '../db/index.js';
import { sensorReadings, settings, weatherCache, statusMessages } from '../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import { analyzeCoopTelemetry } from '../services/ollama.service.js';
import { randomUUID } from 'node:crypto';
import { localDate } from '../util/local-date.js';

export async function aiAnalysisJob(): Promise<void> {
  console.log('[Job:ai-analysis] Running');
  try {
    const [latestSensor] = await db.select().from(sensorReadings)
      .orderBy(desc(sensorReadings.createdAt))
      .limit(1);

    const [cfg] = await db.select().from(settings).where(eq(settings.id, 1));

    const todayStr = localDate();
    const [todayWeather] = await db.select().from(weatherCache)
      .where(sql`${weatherCache.forecastDate} = ${todayStr}`);

    const result = await analyzeCoopTelemetry({
      currentTimeLocal: new Date().toLocaleTimeString(),
      doorState: latestSensor?.doorState ?? 'UNKNOWN',
      chickensInside: latestSensor?.chickensInside ?? 0,
      totalChickens: cfg?.totalChickens ?? 10,
      weatherCode: todayWeather?.weatherCode,
      tempMax: todayWeather?.tempMax,
      weatherLock: todayWeather?.isSevere ?? false,
      serviceMode: cfg?.serviceMode ?? false,
      sunriseLocal: todayWeather?.sunrise,
      sunsetLocal: todayWeather?.sunset,
      contextNote: 'Scheduled hourly analysis',
    });

    // Persist result as a status message so the Angular frontend sees it
    if (result.analysisText) {
      const now = new Date();
      await db.insert(statusMessages).values({
        id: randomUUID(),
        text: result.analysisText,
        timestamp: now.toTimeString().split(' ')[0]!,
        isWarning: result.isWarning,
        isError: false,
        isPinned: result.isWarning,
        category: result.isWarning ? 'AI_WARNING' : 'AI_REPORT',
      });
    }

    console.log(`[Job:ai-analysis] Done. Warning=${result.isWarning}`);
  } catch (err) {
    console.error('[Job:ai-analysis] Failed:', (err as Error).message);
  }
}
