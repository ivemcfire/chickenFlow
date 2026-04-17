import { GoogleGenAI } from '@google/genai';
import { db } from '../db/index.js';
import { aiAnalysisLog, cameraCaptures, sensorReadings, settings, weatherCache } from '../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import type { AiAnalyzeResponse, ThreatType } from '../api/types.js';
import { stripJsonFences } from './strip-json-fences.js';

const ai = new GoogleGenAI({ apiKey: process.env['GEMINI_API_KEY'] });

const MODEL = 'gemini-2.5-flash-lite';

// ── System prompts ────────────────────────────────────────────────────────────

const TELEMETRY_SYSTEM_PROMPT = `You are ChickenFlow-AI, the monitoring intelligence for an automated chicken coop door system.

Analyze real-time telemetry and produce a single concise status assessment.

Rules:
- Respond in 15-25 words maximum.
- Tone: professional, slightly warm — never flippant when safety is at stake.
- Use "WARNING:" prefix if chickens_inside / total_chickens < 0.5 and door is CLOSED.
- If door is ERROR: mention possible obstruction or motor fault.
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
  "message": "15-25 word assessment",
  "threat_type": null | "predator" | "obstruction" | "injury"
}

Rules:
- Set anomaly: true immediately if you see a fox, raccoon, dog, cat, hawk, or any predator.
- Set anomaly: true for a stuck door, visible obstruction, or injured bird.
- message must describe the most safety-critical observation first.
- Do NOT count or verify chickens — chicken counting is handled by the IR sensor.
- If the image is too dark or unclear to assess: anomaly: false, message: "Image quality insufficient for analysis."`;

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
    inside_percent: telemetry.totalChickens > 0 ? Math.round((telemetry.chickensInside / telemetry.totalChickens) * 100) : 0,
    weather_code: telemetry.weatherCode ?? null,
    temp_max_c: telemetry.tempMax ?? null,
    weather_lock_active: telemetry.weatherLock,
    service_mode_active: telemetry.serviceMode,
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
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: userMessage,
      config: {
        systemInstruction: TELEMETRY_SYSTEM_PROMPT,
        maxOutputTokens: 128,
      },
    });

    analysisText = response.text ?? 'Analysis complete.';
    promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
    completionTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    isWarning = analysisText.startsWith('WARNING:') || telemetry.weatherLock;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    analysisText = 'AI module offline. Manual monitoring advised.';
    isWarning = true;
  }

  const durationMs = Date.now() - startMs;

  await db.insert(aiAnalysisLog).values({
    model: MODEL,
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
    contextNote: telemetry.contextNote,
    analysisText,
    isWarning,
    errorMessage,
    durationMs,
  });

  wsBroadcaster.broadcast('ai:analysis_complete', { analysisText, isWarning, durationMs });

  return { analysisText, isWarning, promptTokens, completionTokens, durationMs };
}

// ── IP cam snapshot fetch ─────────────────────────────────────────────────────

export async function fetchCamSnapshot(): Promise<Buffer> {
  const frigateUrl = process.env['FRIGATE_URL'];
  const coopCam = process.env['FRIGATE_COOP_CAM'];
  if (!frigateUrl || !coopCam) throw new Error('FRIGATE_URL / FRIGATE_COOP_CAM not configured');
  const url = `${frigateUrl}/api/${coopCam}/latest.jpg`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`Frigate snapshot fetch failed: ${resp.status} ${resp.statusText}`);
  return Buffer.from(await resp.arrayBuffer());
}

// ── Obstruction confidence check (safety gate) ───────────────────────────────
// Called by the ESP32 *after* its local safety stop. Returns a confidence
// that a chicken/animal is directly under the door. Firmware only escalates
// to ERROR when confidence >= 0.8; otherwise it resumes the close cycle.

const OBSTRUCTION_PROMPT = `You are the ChickenFlow obstruction safety gate.

The door motor detected a current stall while closing, indicating a possible obstruction. Your job: inspect the attached coop image and decide whether a chicken, animal, or object is *directly* under the door opening.

Return ONLY valid JSON:
{
  "confidence": 0.0-1.0,
  "reason": "short phrase"
}

Rules:
- 0.8-1.0: clearly visible chicken/animal/object in the door threshold area.
- 0.4-0.79: something is there but unclear (shadow, partial occlusion, motion blur).
- 0.0-0.39: threshold appears clear; likely a false motor stall trigger.
- If image is too dark or unusable: confidence 0.5, reason "image unusable".
- Reason: max 10 words.`;

export interface ObstructionAssessment {
  abort: boolean;
  confidence: number;
  reason: string;
}

export async function assessObstruction(doorState: string): Promise<ObstructionAssessment> {
  const startMs = Date.now();
  let confidence = 0.5;
  let reason = 'default';
  let errorMessage: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    const imageBuffer = await fetchCamSnapshot();
    const base64Image = imageBuffer.toString('base64');

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
            { text: JSON.stringify({ door_state: doorState }) },
          ],
        },
      ],
      config: {
        systemInstruction: OBSTRUCTION_PROMPT,
        maxOutputTokens: 128,
        responseMimeType: 'application/json',
      },
    });

    const rawJson = response.text ?? '{}';
    promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
    completionTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    const parsed = JSON.parse(stripJsonFences(rawJson)) as { confidence: number; reason: string };
    confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5)));
    reason = parsed.reason ?? 'no reason';
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    reason = 'ai unavailable — defaulting to safe retry';
    confidence = 0.5;
  }

  const durationMs = Date.now() - startMs;
  const abort = confidence >= 0.8;

  await db.insert(aiAnalysisLog).values({
    model: MODEL,
    promptTokens,
    completionTokens,
    hasImage: true,
    doorState,
    chickensInside: 0,
    totalChickens: 0,
    contextNote: `obstruction-check confidence=${confidence.toFixed(2)} abort=${abort}`,
    analysisText: reason,
    isWarning: abort,
    anomalyDetected: abort,
    threatType: abort ? 'obstruction' : null,
    errorMessage,
    durationMs,
  });

  if (abort) {
    wsBroadcaster.broadcast('system:alert', {
      severity: 'error',
      text: `DOOR BLOCKED: ${reason} (${Math.round(confidence * 100)}%)`,
      category: 'DOOR_OBSTRUCTED',
      isPinned: true,
    });
  }

  return { abort, confidence, reason };
}

// ── Vision analysis (image + telemetry) ──────────────────────────────────────

export async function analyzeCapture(captureId: number, imageBuffer: Buffer): Promise<void> {
  const startMs = Date.now();

  // Read current state from DB for telemetry snapshot
  const [latestSensor] = await db.select().from(sensorReadings).orderBy(desc(sensorReadings.createdAt)).limit(1);
  const [currentSettings] = await db.select().from(settings).where(eq(settings.id, 1));
  const todayStr = new Date().toISOString().split('T')[0];
  const [todayWeather] = await db.select().from(weatherCache)
    .where(sql`${weatherCache.forecastDate} = ${todayStr}`);

  const telemetry = {
    door_state: latestSensor?.doorState ?? 'UNKNOWN',
    chickens_inside: latestSensor?.chickensInside ?? 0,
    total_chickens: currentSettings?.totalChickens ?? 10,
    inside_percent: latestSensor && (currentSettings?.totalChickens ?? 0) > 0
      ? Math.round((latestSensor.chickensInside / (currentSettings!.totalChickens)) * 100)
      : 0,
    weather_code: todayWeather?.weatherCode ?? null,
    weather_lock_active: todayWeather?.isSevere ?? false,
    service_mode_active: currentSettings?.serviceMode ?? false,
  };

  let anomalyDetected = false;
  let threatType: ThreatType = null;
  let analysisText = 'Vision analysis unavailable.';
  let promptTokens = 0;
  let completionTokens = 0;
  let errorMessage: string | null = null;

  try {
    const base64Image = imageBuffer.toString('base64');

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
            { text: JSON.stringify(telemetry, null, 2) },
          ],
        },
      ],
      config: {
        systemInstruction: VISION_SYSTEM_PROMPT,
        maxOutputTokens: 256,
        responseMimeType: 'application/json',
      },
    });

    const rawJson = response.text ?? '{}';
    promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
    completionTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

    const parsed = JSON.parse(stripJsonFences(rawJson)) as {
      anomaly: boolean;
      message: string;
      threat_type: string | null;
    };

    anomalyDetected = parsed.anomaly ?? false;
    threatType = (parsed.threat_type as ThreatType) ?? null;
    analysisText = parsed.message ?? 'Analysis complete.';

  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    analysisText = 'Vision module offline.';
    console.error('[Vision]', errorMessage);
  }

  const durationMs = Date.now() - startMs;

  const [logRow] = await db.insert(aiAnalysisLog).values({
    model: MODEL,
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
    errorMessage,
    durationMs,
  }).returning();

  // Update capture row: link to analysis log + set anomaly flag (single write)
  await db.update(cameraCaptures)
    .set({ aiAnalysisId: logRow!.id, isAnomaly: anomalyDetected, threatType })
    .where(eq(cameraCaptures.id, captureId));

  // If anomaly: queue a CLOSE command and broadcast alert
  if (anomalyDetected && threatType === 'predator') {
    await db.update(settings)
      .set({ pendingCommand: 'CLOSE' })
      .where(eq(settings.id, 1));

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
