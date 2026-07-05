export type DoorState = 'OPEN' | 'CLOSED' | 'OPENING' | 'CLOSING' | 'ERROR';
export type DoorTrigger = 'manual' | 'solar' | 'weather' | 'smart' | 'herding' | 'obstruction' | 'esp32';
export type ThreatType = 'predator' | 'obstruction' | 'injury' | null;

// Request body shapes now live as zod schemas in ./schemas.ts (DoorCommandBody,
// SettingsPatchBody, StatusMessageBody, AiAnalyzeBody) — z.infer replaces the
// hand-written interfaces that used to live here.

export interface AiAnalyzeResponse {
  analysisText: string;
  isWarning: boolean;
  anomalyDetected?: boolean;
  threatType?: ThreatType;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export interface WeatherDay {
  forecastDate: string;
  weatherCode: number;
  tempMax: number;
  tempMin: number;
  sunrise: string;
  sunset: string;
  isSevere: boolean;
}

// WebSocket event names
export type WsEventName =
  | 'door:state_changed'
  | 'door:command_received'
  | 'sensor:reading'
  | 'system:alert'
  | 'system:message'
  | 'weather:updated'
  | 'ai:analysis_complete'
  | 'camera:new_capture'
  | 'esp32:status';

export interface WsEnvelope {
  event: WsEventName;
  payload: unknown;
  ts: number;
}
