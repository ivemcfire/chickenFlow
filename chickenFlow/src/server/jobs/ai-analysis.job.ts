import { db } from '../db/index.js';
import { settings, weatherCache, statusMessages, chickenCounts, deviceStatus } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { analyzeCoopTelemetry, type CoopTelemetry } from '../services/gemini.service.js';
import { getDoorState } from '../services/door-state.service.js';
import { localDate } from '../util/local-date.js';

// Assembles the AI's view of the coop entirely from real, server-owned state
// — never from client-supplied telemetry. Shared by the hourly cron job and
// the on-demand POST /ai/analyze route so both feed the model the same facts.
export async function assembleCoopTelemetry(contextNote?: string): Promise<CoopTelemetry> {
  const doorState = await getDoorState();
  const todayStr = localDate();

  const [countRow] = await db.select().from(chickenCounts).where(eq(chickenCounts.date, todayStr));
  const [cfg] = await db.select().from(settings).where(eq(settings.id, 1));
  const [todayWeather] = await db.select().from(weatherCache)
    .where(sql`${weatherCache.forecastDate} = ${todayStr}`);
  // Single-device system — device_status has exactly one row (esp32-s2-coop).
  const [device] = await db.select().from(deviceStatus).limit(1);

  return {
    currentTimeLocal: new Date().toLocaleTimeString(),
    doorState,
    chickensInside: countRow?.netInside ?? 0,
    totalChickens: cfg?.totalChickens ?? 10,
    weatherCode: todayWeather?.weatherCode,
    tempMax: todayWeather?.tempMax,
    weatherLock: todayWeather?.isSevere ?? false,
    serviceMode: cfg?.serviceMode ?? false,
    sunriseLocal: todayWeather?.sunrise,
    sunsetLocal: todayWeather?.sunset,
    deviceRssi: device?.rssi ?? undefined,
    deviceVoltageV: device?.voltageV ?? undefined,
    deviceTempC: device?.tempC ?? undefined,
    deviceLightLevel: device?.lightLevel ?? undefined,
    deviceLastSeen: device?.lastSeen?.toISOString(),
    contextNote,
  };
}

export async function aiAnalysisJob(): Promise<void> {
  console.log('[Job:ai-analysis] Running');
  try {
    const telemetry = await assembleCoopTelemetry('Scheduled hourly analysis');
    const result = await analyzeCoopTelemetry(telemetry);

    // Persist result as a status message so the Angular frontend sees it
    if (result.analysisText) {
      await db.insert(statusMessages).values({
        text: result.analysisText,
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
