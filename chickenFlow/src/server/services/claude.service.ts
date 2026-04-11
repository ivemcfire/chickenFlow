import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { db } from '../db/index.js';
import { aiAnalysisLog, cameraCaptures, sensorReadings, settings, weatherCache } from '../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import type { AiAnalyzeResponse, ThreatType } from '../api/types.js';

const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

// ── System prompts ────────────────────────────────────────────────────────────

const TELEMETRY_SYSTEM_PROMPT = `You are ChickenFlow-AI, the monitoring intelligence for an automated chicken coop door system.

Analyze real-time telemetry and produce a single concise status assessment.

Rules:
- Respond in 15-25 words maximum.
- Tone: professional, slightly warm — never flippant when safety is at stake.
- Use "WARNING:" prefix if chickens_inside / total_chickens < 0.5 and door is CLOSED.
- If obstruction_distance_cm < 20 and door is CLOSING or ERROR: mention obstruction.
- If weather_lock is true: always reference safety confinement.
- If service_mode is true: note that automated systems are paused.
- If all chickens inside and door CLOSED: brief reassurance.
- Never mention API keys, model names, or implementation details.
- Only reference values present in the telemetry JSON.`;

const VISION_SYSTEM_PROMPT = `You are ChickenFlow Vision, the image analysis module for an automated chicken coop door system.

Analyze the attached coop image alongside the provided telemetry JSON.

Return ONLY valid JSON, no other text:
{
  "anomaly": boolean,
  "count_confirmed": boolean,
  "message": "15-25 word assessment",
  "threat_type": null | "predator" | "obstruction" | "injury"
}

Rules:
- Set anomaly: true immediately if you see a fox, raccoon, dog, cat, hawk, or any predator.
- Set anomaly: true for a stuck door, visible obstruction, or injured bird.
- count_confirmed: true if the visible chicken count matches chickens_inside in telemetry (±1 acceptable).
- message must describe the most safety-critical observation first.
- If the image is too dark or unclear to assess: anomaly: false, count_confirmed: false, message: "Image quality insufficient for analysis."`;

// ── Telemetry-only analysis ───────────────────────────────────────────────────

export interface CoopTelemetry {
  currentTimeLocal: string;
  doorState: string;
  chickensInside: number;
  totalChickens: number;
  weatherCode?: number;
  tempMax?: number;
  weatherLock: boolean;
  serviceMode: boolean;
  obstructionDistance?: number;
  contextNote?: string;
  sunriseLocal?: string;
  sunsetLocal?: string;
}

export async function analyzeCoopTelemetry(telemetry: CoopTelemetry): Promise<AiAnalyzeResponse> {
  const startMs = Date.now();

  const userMessage = JSON.stringify({
    current_time_local: telemetry.currentTimeLocal,
    door_state: telemetry.doorState,
    chickens_inside: telemetry.chickensInside,
    total_chickens: telemetry.totalChickens,
    inside_percent: Math.round((telemetry.chickensInside / telemetry.totalChickens) * 100),
    weather_code: telemetry.weatherCode ?? null,
    temp_max_c: telemetry.tempMax ?? null,
    weather_lock_active: telemetry.weatherLock,
    service_mode_active: telemetry.serviceMode,
    obstruction_distance_cm: telemetry.obstructionDistance ?? null,
    sunrise_local: telemetry.sunriseLocal ?? null,
    sunset_local: telemetry.sunsetLocal ?? null,
    context_note: telemetry.contextNote ?? null,
  }, null, 2);

  let analysisText = 'Analysis unavailable.';
  let isWarning = false;
  let promptTokens = 0;
  let completionTokens = 0;
  let errorMessage: string | null = null;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 128,
      system: TELEMETRY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    analysisText = textBlock?.text ?? 'Analysis complete.';
    promptTokens = response.usage.input_tokens;
    completionTokens = response.usage.output_tokens;
    isWarning = analysisText.startsWith('WARNING:') || telemetry.weatherLock;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    analysisText = 'AI module offline. Manual monitoring advised.';
    isWarning = true;
  }

  const durationMs = Date.now() - startMs;

  db.insert(aiAnalysisLog).values({
    model: 'claude-sonnet-4-6',
    promptTokens,
    completionTokens,
    hasImage: false,
    doorState: telemetry.doorState,
    chickensInside: telemetry.chickensInside,
    totalChickens: telemetry.totalChickens,
    weatherCode: telemetry.weatherCode,
    tempMax: telemetry.tempMax,
    weatherLock: telemetry.weatherLock,
    serviceMode: telemetry.serviceMode,
    obstructionDistance: telemetry.obstructionDistance,
    contextNote: telemetry.contextNote,
    analysisText,
    isWarning,
    errorMessage,
    durationMs,
  }).run();

  wsBroadcaster.broadcast('ai:analysis_complete', { analysisText, isWarning, durationMs });

  return { analysisText, isWarning, promptTokens, completionTokens, durationMs };
}

// ── Vision analysis (image + telemetry) ──────────────────────────────────────

export async function analyzeCapture(captureId: number, filePath: string): Promise<void> {
  const startMs = Date.now();

  // Read current state from DB for telemetry snapshot
  const latestSensor = db.select().from(sensorReadings).orderBy(desc(sensorReadings.createdAt)).limit(1).get();
  const currentSettings = db.select().from(settings).where(eq(settings.id, 1)).get();
  const todayStr = new Date().toISOString().split('T')[0];
  const todayWeather = db.select().from(weatherCache)
    .where(sql`${weatherCache.forecastDate} = ${todayStr}`)
    .get();

  const telemetry = {
    door_state: latestSensor?.doorState ?? 'UNKNOWN',
    chickens_inside: latestSensor?.chickensInside ?? 0,
    total_chickens: currentSettings?.totalChickens ?? 10,
    inside_percent: latestSensor
      ? Math.round((latestSensor.chickensInside / (currentSettings?.totalChickens ?? 10)) * 100)
      : 0,
    weather_code: todayWeather?.weatherCode ?? null,
    weather_lock_active: todayWeather?.isSevere ?? false,
    service_mode_active: currentSettings?.serviceMode ?? false,
    obstruction_distance_cm: latestSensor?.distanceCm ?? null,
  };

  let anomalyDetected = false;
  let threatType: ThreatType = null;
  let countConfirmed: boolean | null = null;
  let analysisText = 'Vision analysis unavailable.';
  let promptTokens = 0;
  let completionTokens = 0;
  let errorMessage: string | null = null;

  try {
    const imageBuffer = readFileSync(filePath);
    const base64Image = imageBuffer.toString('base64');

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      system: VISION_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Image },
          },
          { type: 'text', text: JSON.stringify(telemetry, null, 2) },
        ],
      }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const rawJson = textBlock?.text ?? '{}';
    promptTokens = response.usage.input_tokens;
    completionTokens = response.usage.output_tokens;

    const parsed = JSON.parse(rawJson) as {
      anomaly: boolean;
      count_confirmed: boolean;
      message: string;
      threat_type: string | null;
    };

    anomalyDetected = parsed.anomaly ?? false;
    threatType = (parsed.threat_type as ThreatType) ?? null;
    countConfirmed = parsed.count_confirmed ?? false;
    analysisText = parsed.message ?? 'Analysis complete.';

  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    analysisText = 'Vision module offline.';
    console.error('[Vision]', errorMessage);
  }

  const durationMs = Date.now() - startMs;

  // Update the capture row with anomaly flag
  db.update(cameraCaptures)
    .set({ isAnomaly: anomalyDetected, threatType })
    .where(eq(cameraCaptures.id, captureId))
    .run();

  const logRow = db.insert(aiAnalysisLog).values({
    model: 'claude-sonnet-4-6',
    promptTokens,
    completionTokens,
    hasImage: true,
    doorState: telemetry.door_state,
    chickensInside: telemetry.chickens_inside,
    totalChickens: telemetry.total_chickens,
    weatherCode: telemetry.weather_code ?? undefined,
    weatherLock: telemetry.weather_lock_active,
    serviceMode: telemetry.service_mode_active,
    analysisText,
    isWarning: anomalyDetected,
    anomalyDetected,
    threatType,
    countConfirmed: countConfirmed ?? undefined,
    errorMessage,
    durationMs,
  }).returning().get();

  // Link capture → analysis log
  db.update(cameraCaptures)
    .set({ aiAnalysisId: logRow.id })
    .where(eq(cameraCaptures.id, captureId))
    .run();

  // If anomaly: queue a CLOSE command and broadcast alert
  if (anomalyDetected && threatType === 'predator') {
    db.update(settings)
      .set({ pendingCommand: 'CLOSE' })
      .where(eq(settings.id, 1))
      .run();

    wsBroadcaster.broadcast('system:alert', {
      severity: 'error',
      text: `THREAT DETECTED: ${threatType}. ${analysisText}`,
      category: 'VISION_THREAT',
      isPinned: true,
    });
  }

  wsBroadcaster.broadcast('ai:analysis_complete', {
    analysisText,
    isWarning: anomalyDetected,
    anomalyDetected,
    threatType,
    captureId,
    durationMs,
  });
}
