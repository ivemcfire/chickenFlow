import { Injectable, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Subject } from 'rxjs';

// ── Backend response types ──────���────────────────────────────────────────────

export interface ApiSettings {
  totalChickens: number;
  serviceMode: boolean;
  automaticDoor: boolean;
  musicDuration: number;
  smartNightLight: boolean;
  locationLat: number;
  locationLon: number;
}

export interface ApiWeatherDay {
  forecastDate: string;
  weatherCode: number;
  tempMax: number;
  tempMin: number;
  sunrise: string;
  sunset: string;
  isSevere: boolean;
}

export interface ApiDoorState {
  state: string;
}

export interface ApiSensorReading {
  distanceCm: number;
  irTriggered: boolean;
  chickensInside: number;
  totalChickens: number;
  doorState: string;
  createdAt: string;
}

export interface ApiCaptureRow {
  id: number;
  filePath: string;
  fileSizeBytes: number;
  widthPx: number;
  heightPx: number;
  doorStateAtCapture: string;
  chickensInsideAtCapture: number | null;
  isAnomaly: boolean;
  threatType: string | null;
  aiAnalysisId: number | null;
  createdAt: string;
}

export interface ApiAiResponse {
  analysisText: string;
  isWarning: boolean;
  anomalyDetected?: boolean;
  threatType?: string | null;
  durationMs: number;
}

export interface WsEnvelope {
  event: string;
  payload: any;
  ts: number;
}

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private platformId = inject(PLATFORM_ID);
  private ws: WebSocket | null = null;

  /** Emits every WebSocket message from the backend */
  readonly wsMessage$ = new Subject<WsEnvelope>();

  /** True once the initial WebSocket connection is established */
  private wsConnected = false;

  // ── REST API calls ─────────────────────────────────────────────────────────

  getSettings() {
    return this.http.get<ApiSettings>('/api/settings');
  }

  putSettings(settings: Partial<ApiSettings>) {
    return this.http.put<ApiSettings>('/api/settings', settings);
  }

  getDoorState() {
    return this.http.get<ApiDoorState>('/api/door/state');
  }

  sendDoorCommand(command: 'OPEN' | 'CLOSE', trigger = 'manual', chickensInside?: number) {
    return this.http.post<{ queued: string }>('/api/door/command', {
      command,
      trigger,
      chickensInside,
    });
  }

  getWeatherToday() {
    return this.http.get<ApiWeatherDay | null>('/api/weather/today');
  }

  getWeatherForecast() {
    return this.http.get<ApiWeatherDay[]>('/api/weather/forecast');
  }

  getLatestSensor() {
    return this.http.get<ApiSensorReading | null>('/api/esp32/latest');
  }

  getLatestCapture() {
    return this.http.get<ApiCaptureRow | null>('/api/camera/latest');
  }

  takeSnapshot() {
    return this.http.post<{ id: number; ok: boolean }>('/api/ai/snapshot', {});
  }

  runAiAnalysis(body: {
    doorState: string;
    chickensInside: number;
    totalChickens: number;
    weatherCode?: number;
    tempMax?: number;
    weatherLock: boolean;
    serviceMode: boolean;
    obstructionDistance?: number;
    contextNote?: string;
  }) {
    return this.http.post<ApiAiResponse>('/api/ai/analyze', body);
  }

  getHealth() {
    return this.http.get<{ status: string; dbWritable: boolean }>('/api/health');
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  connectWebSocket() {
    if (!isPlatformBrowser(this.platformId)) return;
    if (this.wsConnected) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws`;

    this.createWs(url);
  }

  private createWs(url: string) {
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect(url);
      return;
    }

    this.ws.onopen = () => {
      this.wsConnected = true;
      console.log('[WS] Connected');
    };

    this.ws.onmessage = (ev) => {
      try {
        const envelope = JSON.parse(ev.data) as WsEnvelope;
        this.wsMessage$.next(envelope);
      } catch {
        // Ignore non-JSON messages
      }
    };

    this.ws.onclose = () => {
      this.wsConnected = false;
      console.log('[WS] Disconnected — reconnecting in 5s');
      this.scheduleReconnect(url);
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect(url: string) {
    if (isPlatformBrowser(this.platformId)) {
      setTimeout(() => this.createWs(url), 5000);
    }
  }
}
