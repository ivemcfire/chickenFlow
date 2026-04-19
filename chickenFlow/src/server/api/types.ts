export type DoorState = 'OPEN' | 'CLOSED' | 'OPENING' | 'CLOSING' | 'ERROR';
export type DoorTrigger = 'manual' | 'solar' | 'weather' | 'smart' | 'herding' | 'obstruction' | 'esp32';
export type ThreatType = 'predator' | 'obstruction' | 'injury' | null;

export interface ApiSettings {
  totalChickens: number;
  serviceMode: boolean;
  automaticDoor: boolean;
  musicDuration: number;
  smartNightLight: boolean;
  locationLat: number;
  locationLon: number;
  pendingCommand: string;
}

export interface DoorCommandRequest {
  command: 'OPEN' | 'CLOSE';
  trigger: DoorTrigger;
  chickensInside?: number;
}

export interface SensorReadingRequest {
  topSensorTriggered?: boolean;  // door-open limit switch (pin 12)
  irTriggered?: boolean;         // legacy single-beam field
  irATriggered?: boolean;        // tunnel beam A (coop side)
  irBTriggered?: boolean;        // tunnel beam B (yard side)
  ir1?: boolean;                 // firmware alias for irATriggered
  ir2?: boolean;                 // firmware alias for irBTriggered
  direction?: 'IN' | 'OUT';      // latched traversal event since last post
  lightLevel?: number;           // LDR EMA raw ADC 0..4095
  chickensInside: number;
  totalChickens: number;
  doorState: string;
}

export interface ObstructionCheckRequest {
  doorState: string;
}

export interface ObstructionCheckResponse {
  abort: boolean;       // true = confidence >= 80%, door should ERROR; false = retry
  confidence: number;   // 0..1
  reason: string;
}

export interface StatusMessageRequest {
  id: string;
  text: string;
  timestamp: string;
  isWarning: boolean;
  isError: boolean;
  isPinned: boolean;
  category?: string;
}

export interface AiAnalyzeRequest {
  doorState: string;
  chickensInside: number;
  totalChickens: number;
  weatherCode?: number;
  tempMax?: number;
  weatherLock: boolean;
  serviceMode: boolean;
  contextNote?: string;
  // Optional: camera capture id to include image in analysis
  captureId?: number;
}

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
