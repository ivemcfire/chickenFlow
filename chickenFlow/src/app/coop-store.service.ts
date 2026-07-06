import { Injectable, signal, computed, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService, type ApiSettings, type ApiWeatherDay, type DoorCommandReason } from './api.service';
import { MessagesService } from './messages.service';

// ─────────────────────────────────────────────────────────────────────────────
// CoopStore — the frontend's mirror of server-side truth.
//
// The backend (door_events fed by the ESP32 over MQTT, plus cron-driven solar
// / weather-lockdown / manual-override-expiry automation) is authoritative
// for everything here. This store hydrates from REST on startup, updates
// live from WebSocket broadcasts, and re-hydrates after every reconnect so a
// dropped socket never leaves stale state on screen. It exposes command
// methods that just ask the backend to do something — it never decides
// anything on its own.
// ─────────────────────────────────────────────────────────────────────────────

export enum DoorState {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  OPENING = 'OPENING',
  CLOSING = 'CLOSING',
  ERROR = 'ERROR',
  UNKNOWN = 'UNKNOWN',
}

const DOOR_STATES = new Set(Object.values(DoorState));
function isDoorState(value: unknown): value is DoorState {
  return typeof value === 'string' && DOOR_STATES.has(value as DoorState);
}

export interface WeatherDay {
  day: string;
  temp: number;
  code: number;
  icon: string;
}

export interface SolarCountdown {
  label: string;
  text: string;
}

const FALLBACK_FORECAST: WeatherDay[] = [
  { day: 'Mon', temp: 18, code: 0, icon: 'wb_sunny' },
  { day: 'Tue', temp: 16, code: 3, icon: 'cloud' },
  { day: 'Wed', temp: 14, code: 61, icon: 'water_drop' },
  { day: 'Thu', temp: 15, code: 3, icon: 'cloud' },
  { day: 'Fri', temp: 19, code: 0, icon: 'wb_sunny' },
];

@Injectable({ providedIn: 'root' })
export class CoopStore {
  private api = inject(ApiService);
  private messages = inject(MessagesService);
  private platformId = inject(PLATFORM_ID);

  // ── Server mirror ──────────────────────────────────────────────────────
  readonly doorState = signal<DoorState>(DoorState.UNKNOWN);
  readonly totalChickens = signal<number>(10);
  readonly chickensInside = signal<number>(0);
  readonly serviceMode = signal<boolean>(false);
  readonly automaticDoor = signal<boolean>(true);
  readonly musicDuration = signal<number>(5);
  readonly smartNightLight = signal<boolean>(true);
  /** Epoch ms, or null when no manual-open window is active (mirrors settings.manualOverrideUntil). */
  readonly manualOverrideUntil = signal<number | null>(null);

  readonly esp32Online = signal<boolean>(false);
  readonly esp32LastSeen = signal<string | null>(null);
  // LDR is "functioning" once we've seen a numeric lightLevel from the ESP32
  // AND the backend hasn't pinned an LDR_FAILSAFE alert. Default false until proven.
  readonly ldrOnline = signal<boolean>(false);
  readonly ir1 = signal<boolean>(false);
  readonly ir2 = signal<boolean>(false);
  readonly lightLevel = signal<number | null>(null);
  readonly backendOnline = signal<boolean>(true);

  readonly weatherForecast = signal<WeatherDay[]>([]);
  readonly weatherUpdatedAt = signal<string | null>(null);
  readonly sunriseIso = signal<string | null>(null);
  readonly sunsetIso = signal<string | null>(null);
  readonly todayIsSevere = signal<boolean>(false);
  /** Static display label — the backend only stores lat/lon, not a place name. */
  readonly weatherLocation = 'Antonovo, BG';

  readonly isAnalyzing = signal<boolean>(false);
  readonly startTime = signal<string>(new Date().toLocaleString());

  /** Ticks once a second (browser-only) purely to keep countdown displays fresh. */
  private readonly tick = signal(0);

  // ── Derived / display-only ─────────────────────────────────────────────
  readonly doorOpen = computed(() => {
    const st = this.doorState();
    return st === DoorState.OPEN || st === DoorState.OPENING;
  });

  readonly weatherLock = computed(() => this.todayIsSevere() && !this.serviceMode());

  readonly doorOpenTime = computed(() => {
    const sr = this.sunriseIso();
    return sr ? this.formatClock(new Date(sr).getTime() + 60 * 60_000) : '--:--';
  });

  readonly doorCloseTime = computed(() => {
    const ss = this.sunsetIso();
    return ss ? this.formatClock(new Date(ss).getTime() + 30 * 60_000) : '--:--';
  });

  // Solar countdown — pure ms arithmetic on the absolute Date parsed from the
  // ISO sunrise/sunset strings the weather API returns. No re-basing onto the
  // client's own local "today", so it stays correct regardless of which
  // timezone the browser is in.
  readonly solarCountdown = computed<SolarCountdown>(() => {
    this.tick();
    const sr = this.sunriseIso();
    const ss = this.sunsetIso();
    if (!sr || !ss) return { label: 'Solar Syncing', text: '--:--:--' };

    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const sunriseMs = new Date(sr).getTime();
    const sunsetMs = new Date(ss).getTime();

    let targetMs: number;
    let label: string;
    if (now < sunriseMs) {
      targetMs = sunriseMs;
      label = 'Time till door opens';
    } else if (now < sunsetMs) {
      targetMs = sunsetMs;
      label = 'Time till door closing';
    } else {
      targetMs = sunriseMs + DAY_MS;
      label = 'Time till door opens';
    }

    const diff = Math.max(0, targetMs - now);
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    const seconds = Math.floor((diff % 60_000) / 1000);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return { label, text: `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` };
  });

  readonly manualOverrideMinutesLeft = computed<number | null>(() => {
    this.tick();
    const until = this.manualOverrideUntil();
    if (until === null) return null;
    const diffMs = until - Date.now();
    if (diffMs <= 0) return 0;
    return Math.ceil(diffMs / 60_000);
  });

  readonly doorStatusLabel = computed(() => {
    const st = this.doorState();
    if (st === DoorState.ERROR) return 'ALARM: OBSTRUCTION';

    const doorLabel = this.doorOpen() ? 'OPENED' : 'CLOSED';
    if (this.serviceMode()) return `SYSTEM: SERVICE MODE - DOOR: ${doorLabel}`;
    if (this.doorOpen()) return `SYSTEM: MANUAL MODE - DOOR: ${doorLabel}`;

    const sr = this.sunriseIso();
    const ss = this.sunsetIso();
    if (!sr || !ss) return `SYSTEM: SYNCING - DOOR: ${doorLabel}`;

    const now = Date.now();
    const isDay = now >= new Date(sr).getTime() && now < new Date(ss).getTime();
    return `SYSTEM: ${isDay ? 'DAY MODE' : 'NIGHT MODE'} - DOOR: ${doorLabel}`;
  });

  private wsOpenCount = 0;

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return; // SSR guard

    setInterval(() => this.tick.update((v) => v + 1), 1000);

    this.hydrate();
    this.api.connectWebSocket();
    this.subscribeToWsEvents();

    // Re-hydrate on every reconnect (not the very first open, which the
    // constructor's own hydrate() already covers) so a dropped socket never
    // leaves this store stale once the connection comes back.
    this.api.wsOpen$.subscribe(() => {
      this.wsOpenCount++;
      if (this.wsOpenCount > 1) this.hydrate();
    });
  }

  // ── Hydration (REST) ────────────────────────────────────────────────────

  private hydrate() {
    this.refreshSettings();
    this.refreshDoorState();
    this.refreshEsp32Status();
    this.refreshWeather();
    this.refreshHealth();
  }

  private refreshSettings() {
    this.api.getSettings().subscribe({
      next: (s) => this.applySettings(s),
    });
  }

  private refreshDoorState() {
    this.api.getDoorState().subscribe({
      next: (d) => {
        if (isDoorState(d.state)) this.doorState.set(d.state);
      },
    });
  }

  private refreshEsp32Status() {
    this.api.getEsp32Status().subscribe({
      next: (s) => {
        this.esp32Online.set(s.online);
        this.esp32LastSeen.set(s.lastSeen);
      },
      error: () => this.esp32Online.set(false),
    });
  }

  private refreshWeather() {
    this.api.getWeatherForecast().subscribe({
      next: (days) => this.applyWeather(days),
      error: () => this.weatherForecast.set(FALLBACK_FORECAST),
    });
  }

  private refreshHealth() {
    this.api.getHealth().subscribe({
      next: (h) => this.backendOnline.set(h.status === 'ok'),
      error: () => this.backendOnline.set(false),
    });
  }

  private applySettings(s: ApiSettings) {
    this.totalChickens.set(s.totalChickens);
    this.serviceMode.set(s.serviceMode);
    this.automaticDoor.set(s.automaticDoor);
    this.musicDuration.set(s.musicDuration);
    this.smartNightLight.set(s.smartNightLight);
    this.manualOverrideUntil.set(s.manualOverrideUntil ? new Date(s.manualOverrideUntil).getTime() : null);
  }

  private applyWeather(days: ApiWeatherDay[]) {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const forecast: WeatherDay[] = days.map((d) => {
      const date = new Date(d.forecastDate + 'T00:00:00');
      return {
        day: dayNames[date.getDay()],
        temp: Math.round(d.tempMax),
        code: d.weatherCode,
        icon: this.weatherIcon(d.weatherCode),
      };
    });
    this.weatherForecast.set(forecast);

    const today = days[0];
    this.weatherUpdatedAt.set(today?.fetchedAt ?? null);
    this.sunriseIso.set(today?.sunrise ?? null);
    this.sunsetIso.set(today?.sunset ?? null);
    this.todayIsSevere.set(today?.isSevere ?? false);
  }

  private weatherIcon(code: number): string {
    if (code === 0) return 'wb_sunny';
    if (code < 4) return 'cloud_queue';
    if (code < 50) return 'cloud';
    if (code < 70) return 'water_drop';
    return 'thunderstorm';
  }

  private formatClock(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  private subscribeToWsEvents() {
    this.api.wsMessage$.subscribe((msg) => {
      switch (msg.event) {
        case 'door:state_changed': {
          const p = msg.payload as { toState: string };
          if (isDoorState(p.toState)) this.doorState.set(p.toState);
          // No WS broadcast exists for settings changes — re-sync manualOverrideUntil
          // (and anything else) whenever the door actually moves.
          this.refreshSettings();
          break;
        }
        case 'door:command_received': {
          const p = msg.payload as { command: string };
          if (p.command === 'OPEN') this.doorState.set(DoorState.OPENING);
          else if (p.command === 'CLOSE') this.doorState.set(DoorState.CLOSING);
          break;
        }
        case 'sensor:reading': {
          const p = msg.payload as {
            irATriggered?: boolean;
            irBTriggered?: boolean;
            chickensInside?: number;
            doorState?: string;
            telemetry?: { lightLevel?: number };
          };
          if (typeof p.chickensInside === 'number') this.chickensInside.set(p.chickensInside);
          if (typeof p.irATriggered === 'boolean') this.ir1.set(p.irATriggered);
          if (typeof p.irBTriggered === 'boolean') this.ir2.set(p.irBTriggered);
          if (typeof p.telemetry?.lightLevel === 'number') {
            this.lightLevel.set(p.telemetry.lightLevel);
            this.ldrOnline.set(true);
          }
          if (isDoorState(p.doorState)) this.doorState.set(p.doorState);
          this.esp32Online.set(true);
          break;
        }
        case 'esp32:status': {
          const p = msg.payload as { online: boolean; lastSeen?: string | null };
          this.esp32Online.set(p.online);
          this.esp32LastSeen.set(p.lastSeen ?? null);
          if (!p.online) {
            // Device is dark — the LDR reading can't be trusted either.
            this.ldrOnline.set(false);
            this.notifyEsp32Offline();
          } else {
            this.messages.unpinCategory('ESP32_OFFLINE');
          }
          break;
        }
        case 'system:alert': {
          const p = msg.payload as { category?: string; isPinned?: boolean };
          if (p.category === 'LDR_FAILSAFE' && p.isPinned) this.ldrOnline.set(false);
          break;
        }
        case 'weather:updated':
          this.refreshWeather();
          break;
      }
    });
  }

  private notifyEsp32Offline() {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    const show = () =>
      new Notification('ChickenFlow: ESP32 offline', {
        body: 'No heartbeat from the controller for 15+ minutes.',
        tag: 'esp32-offline',
      });
    if (Notification.permission === 'granted') {
      show();
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted') show();
      });
    }
  }

  // ── Commands (all via backend) ──────────────────────────────────────────

  openDoor(trigger = 'manual') {
    this.sendCommand('OPEN', trigger);
  }

  closeDoor(trigger = 'manual') {
    this.sendCommand('CLOSE', trigger);
  }

  toggleDoorOpen() {
    if (this.doorOpen()) this.closeDoor('manual');
    else this.openDoor('manual');
  }

  private sendCommand(command: 'OPEN' | 'CLOSE', trigger: string) {
    // Optimistic feedback — the authoritative state arrives via the
    // door:command_received / door:state_changed WS broadcasts.
    this.doorState.set(command === 'OPEN' ? DoorState.OPENING : DoorState.CLOSING);

    this.api.sendDoorCommand(command, trigger).subscribe({
      next: (res) => {
        if (!res.sent) {
          this.messages.post(this.describeSuppressed(res.reason, command));
          this.refreshDoorState(); // undo the optimistic guess above
        }
        this.refreshSettings();
      },
      error: (err: HttpErrorResponse) => {
        const message = (err.error as { message?: string } | null)?.message;
        this.messages.post(
          err.status === 503
            ? 'Controller unreachable — MQTT broker is down, command not delivered.'
            : (message ?? "Couldn't reach the server to control the door."),
          { isWarning: true, isError: true },
        );
        this.refreshDoorState();
      },
    });
  }

  private describeSuppressed(reason: DoorCommandReason, command: 'OPEN' | 'CLOSE'): string {
    switch (reason) {
      case 'already-in-state':
        return `Door is already ${command === 'OPEN' ? 'open' : 'closed'} — command ignored.`;
      case 'already-moving':
        return 'Door is already moving — command ignored.';
      case 'command-in-flight':
        return 'A door command is already in flight — try again in a moment.';
      default:
        return `Door command not sent (${reason}).`;
    }
  }

  setServiceMode(next: boolean) {
    this.serviceMode.set(next);
    this.api.putSettings({ serviceMode: next }).subscribe();
    if (next) {
      this.messages.post('Service Mode ON — automatic door is paused.', {
        isWarning: true,
        isPinned: true,
        category: 'SERVICE_MODE',
      });
    } else {
      this.messages.unpinCategory('SERVICE_MODE');
      this.messages.post('Service Mode OFF — automatic door resumed.');
    }
  }

  setSmartNightLight(next: boolean) {
    this.smartNightLight.set(next);
    this.api.putSettings({ smartNightLight: next }).subscribe();
  }

  setTotalChickens(count: number) {
    if (!Number.isFinite(count) || count < 1) return;
    this.totalChickens.set(count);
    this.api.putSettings({ totalChickens: count }).subscribe();
  }

  runAIAnalysis(contextNote?: string) {
    if (this.serviceMode()) return;
    this.isAnalyzing.set(true);
    this.api.runAiAnalysis({ contextNote }).subscribe({
      next: () => {
        // The status message itself arrives via the ai:analysis_complete WS
        // broadcast (MessagesService re-hydrates on that event).
        this.isAnalyzing.set(false);
      },
      error: () => {
        this.isAnalyzing.set(false);
        this.messages.post('AI assistant is offline.', { isWarning: true, isPinned: true });
      },
    });
  }
}
