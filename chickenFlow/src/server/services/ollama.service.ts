import { db } from '../db/index.js';
import { aiAnalysisLog } from '../db/schema.js';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
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
- If all of: chickens_inside == total_chickens, door_state == "CLOSED", weather_lock false, service_mode false, no error — then brief factual reassurance is allowed. Otherwise state the situation plainly.
- Never mention API keys, model names, or implementation details.
- Only reference values present in the telemetry JSON.`;

interface OllamaGenerateResponse {
  response: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface GenerateResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

async function ollamaGenerate(opts: {
  system: string;
  prompt: string;
  maxTokens: number;
}): Promise<GenerateResult> {
  const ollamaUrl = process.env['OLLAMA_URL'] ?? 'http://ollama.chickenflow.svc.cluster.local:11434';
  const ollamaModel = process.env['OLLAMA_MODEL'] ?? 'qwen2.5:3b-instruct-q4_K_M';

  const resp = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      system: opts.system,
      prompt: opts.prompt,
      stream: false,
      options: { num_predict: opts.maxTokens },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) {
    throw new Error(`Ollama generate failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as OllamaGenerateResponse;

  return {
    text: data.response ?? '',
    promptTokens: data.prompt_eval_count ?? 0,
    completionTokens: data.eval_count ?? 0,
  };
}

export async function analyzeCoopTelemetry(telemetry: CoopTelemetry): Promise<AiAnalyzeResponse> {
  const ollamaModel = process.env['OLLAMA_MODEL'] ?? 'qwen2.5:3b-instruct-q4_K_M';
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
    const result = await ollamaGenerate({
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
    model: ollamaModel,
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
