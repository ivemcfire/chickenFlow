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
  obstructionDistance?: number;
}

export interface SensorReadingRequest {
  distanceCm: number;
  irTriggered: boolean;
  chickensInside: number;
  totalChickens: number;
  doorState: string;
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
  obstructionDistance?: number;
  contextNote?: string;
  // Optional: camera capture id to include image in analysis
  captureId?: number;
}

export interface AiAnalyzeResponse {
  analysisText: string;
  isWarning: boolean;
  anomalyDetected?: boolean;
  threatType?: ThreatType;
  countConfirmed?: boolean;
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
  | 'camera:new_capture';

export interface WsEnvelope {
  event: WsEventName;
  payload: unknown;
  ts: number;
}
