import { Injectable, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Subject } from 'rxjs';

// ── Backend response types ────────────────────────────────────────────────────
// Kept in lockstep with src/server/api/schemas.ts + src/server/api/types.ts —
// the backend is authoritative, this is just the wire shape.

export interface ApiSettings {
  id: number;
  totalChickens: number;
  serviceMode: boolean;
  automaticDoor: boolean;
  musicDuration: number;
  smartNightLight: boolean;
  locationLat: number;
  locationLon: number;
  lightThreshold: number;
  /** ISO timestamp, or null when no manual-open window is active. */
  manualOverrideUntil: string | null;
  updatedAt: string;
}

export interface ApiWeatherDay {
  forecastDate: string;
  weatherCode: number;
  tempMax: number;
  tempMin: number;
  /** ISO datetime as returned by Open-Meteo (no UTC offset — local to the configured lat/lon). */
  sunrise: string;
  sunset: string;
  isSevere: boolean;
  fetchedAt: string;
}

export type ApiDoorStateValue = 'OPEN' | 'CLOSED' | 'OPENING' | 'CLOSING' | 'ERROR' | 'UNKNOWN';

export interface ApiDoorState {
  state: ApiDoorStateValue;
}

export interface ApiDoorEvent {
  id: number;
  fromState: string;
  toState: string;
  trigger: string;
  isManual: boolean;
  chickensInside: number | null;
  totalChickens: number | null;
  createdAt: string;
}

export type DoorCommandReason =
  | 'ok'
  | 'already-in-state'
  | 'already-moving'
  | 'command-in-flight'
  | 'mqtt-disconnected';

export interface ApiDoorCommandResponse {
  sent: boolean;
  reason: DoorCommandReason;
  command: 'OPEN' | 'CLOSE';
}

export interface ApiMessage {
  id: number;
  text: string;
  isWarning: boolean;
  isError: boolean;
  isPinned: boolean;
  category: string | null;
  createdAt: string;
}

export interface ApiPostMessageResult {
  ok: boolean;
  id: number;
}

export interface ApiEsp32Status {
  online: boolean;
  lastSeen: string | null;
}

export interface ApiAiResponse {
  analysisText: string;
  isWarning: boolean;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export interface ApiHealth {
  status: string;
  db: boolean;
  mqtt: unknown;
}

export interface WsEnvelope {
  event: string;
  payload: unknown;
  ts: number;
}

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private platformId = inject(PLATFORM_ID);
  private ws: WebSocket | null = null;

  /** Emits every WebSocket message from the backend. */
  readonly wsMessage$ = new Subject<WsEnvelope>();

  /** Emits once per successful WebSocket connection (including reconnects) —
   *  consumers use this to re-hydrate from REST so a dropped connection never
   *  leaves stale state once it comes back. */
  readonly wsOpen$ = new Subject<void>();

  private wsConnected = false;

  // ── REST API calls ───────────────────────────────────────────────────────

  getSettings() {
    return this.http.get<ApiSettings>('/api/settings');
  }

  putSettings(settings: Partial<ApiSettings>) {
    return this.http.put<ApiSettings>('/api/settings', settings);
  }

  getDoorState() {
    return this.http.get<ApiDoorState>('/api/door/state');
  }

  getDoorEvents(limit = 50) {
    return this.http.get<ApiDoorEvent[]>('/api/door/events', { params: { limit } });
  }

  sendDoorCommand(command: 'OPEN' | 'CLOSE', trigger = 'manual') {
    return this.http.post<ApiDoorCommandResponse>('/api/door/command', { command, trigger });
  }

  getWeatherToday() {
    return this.http.get<ApiWeatherDay | null>('/api/weather/today');
  }

  getWeatherForecast() {
    return this.http.get<ApiWeatherDay[]>('/api/weather/forecast');
  }

  getEsp32Status() {
    return this.http.get<ApiEsp32Status>('/api/esp32/status');
  }

  getMessages() {
    return this.http.get<ApiMessage[]>('/api/messages');
  }

  postMessage(body: { text: string; isWarning?: boolean; isError?: boolean; isPinned?: boolean; category?: string }) {
    return this.http.post<ApiPostMessageResult>('/api/messages', body);
  }

  pinMessage(id: number, pin: boolean) {
    return this.http.patch<{ ok: boolean }>(`/api/messages/${id}/pin`, { pin });
  }

  unpinCategory(category: string) {
    return this.http.patch<{ ok: boolean }>(`/api/messages/category/${category}/unpin`, {});
  }

  deleteMessage(id: number) {
    return this.http.delete<{ ok: boolean }>(`/api/messages/${id}`);
  }

  runAiAnalysis(body: { contextNote?: string }) {
    return this.http.post<ApiAiResponse>('/api/ai/analyze', body);
  }

  getHealth() {
    return this.http.get<ApiHealth>('/api/health');
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

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
      this.wsOpen$.next();
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
