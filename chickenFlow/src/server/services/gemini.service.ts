import { db } from '../db/index.js';
import { aiAnalysisLog } from '../db/schema.js';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import { stripJsonFences } from './strip-json-fences.js';
import type { AiAnalyzeResponse } from '../api/types.js';

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
  // Device diagnostics from device_status (coop/telemetry via MQTT)
  deviceRssi?: number;
  deviceVoltageV?: number;
  deviceTempC?: number;
  deviceLightLevel?: number;
  deviceLastSeen?: string;
}

const TELEMETRY_SYSTEM_PROMPT = `You are ChickenFlow-AI, the monitoring intelligence for an automated chicken coop door system.

Analyze real-time telemetry and produce a single concise status assessment.

Rules:
- Respond in 15-25 words maximum.
- Tone: professional, factual — no exclamation marks, no closing pleasantries (e.g. "enjoy the day", "have a nice day", "cheers", "all good").
- Use "WARNING:" prefix if chickens_inside / total_chickens < 0.5 and door is CLOSED.
- If chickens_inside > total_chickens: prefix with "WARNING: Sensor drift —" and state the mismatch (e.g. "reports 130 of 17").
- If door is ERROR: mention possible obstruction or motor fault.
- If weather_lock is true: always reference safety confinement.
- If service_mode is true: note that automated systems are paused.
- If device diagnostics show rssi weaker than -80, voltage below 10.5, or temp above 45: prefix with "WARNING:" and name the specific reading.
- If all of: chickens_inside == total_chickens, door_state == "CLOSED", weather_lock false, service_mode false, no error — then brief factual reassurance is allowed. Otherwise state the situation plainly.
- Never mention API keys, model names, or implementation details.
- Only reference values present in the telemetry JSON.`;

interface GeminiGenerateResponse {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

interface GenerateResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

// Logged at most once — an hourly cron job with a missing key would otherwise
// fill the logs with the same warning forever.
let hasWarnedMissingKey = false;

async function geminiGenerate(opts: {
  system: string;
  prompt: string;
  maxTokens: number;
}): Promise<GenerateResult> {
  const apiKey = process.env['GEMINI_API_KEY'];
  const model = process.env['GEMINI_MODEL'] ?? 'gemini-2.5-flash';

  if (!apiKey) {
    if (!hasWarnedMissingKey) {
      console.warn('[gemini] GEMINI_API_KEY not set — AI telemetry analysis disabled');
      hasWarnedMissingKey = true;
    }
    throw new Error('GEMINI_API_KEY not configured');
  }

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
        generationConfig: {
          maxOutputTokens: opts.maxTokens,
          // Short-form deterministic telemetry narration doesn't need
          // extended reasoning — disable it to keep latency and cost down.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      // Cloud API — no local cold-start model load to wait out. Generous
      // headroom for a hosted call, without the multi-minute slack the
      // previous self-hosted-model path needed.
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!resp.ok) {
    throw new Error(`Gemini generate failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as GeminiGenerateResponse;
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  return {
    text: stripJsonFences(rawText),
    promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

export async function analyzeCoopTelemetry(telemetry: CoopTelemetry): Promise<AiAnalyzeResponse> {
  const model = process.env['GEMINI_MODEL'] ?? 'gemini-2.5-flash';
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
    device_rssi: telemetry.deviceRssi ?? null,
    device_voltage_v: telemetry.deviceVoltageV ?? null,
    device_temp_c: telemetry.deviceTempC ?? null,
    device_light_level: telemetry.deviceLightLevel ?? null,
    device_last_seen: telemetry.deviceLastSeen ?? null,
    context_note: telemetry.contextNote ?? null,
  }, null, 2);

  let analysisText = 'Analysis unavailable.';
  let isWarning = false;
  let promptTokens = 0;
  let completionTokens = 0;
  let errorMessage: string | null = null;

  try {
    const result = await geminiGenerate({
      system: TELEMETRY_SYSTEM_PROMPT,
      prompt: userMessage,
      maxTokens: 128,
    });

    analysisText = result.text || 'Analysis complete.';
    promptTokens = result.promptTokens;
    completionTokens = result.completionTokens;
    isWarning = analysisText.startsWith('WARNING:') || telemetry.weatherLock;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    analysisText = 'AI module offline. Manual monitoring advised.';
    isWarning = true;
  }

  const durationMs = Date.now() - startMs;

  await db.insert(aiAnalysisLog).values({
    model,
    promptTokens,
    completionTokens,
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
