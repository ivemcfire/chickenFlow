import { Injectable, signal, computed, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ApiService } from './api.service';
import type { ApiWeatherDay, ApiCaptureRow } from './api.service';

export enum DoorState {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  OPENING = 'OPENING',
  CLOSING = 'CLOSING',
  ERROR = 'ERROR'
}

export interface Chicken {
  id: number;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  isInside: boolean;
  type: 'chick';
}

export interface WeatherDay {
  day: string;
  temp: number;
  code: number;
  icon: string;
}

export interface StatusMessage {
  id: string;
  text: string;
  timestamp: string;
  date: Date;
  isWarning: boolean;
  isError: boolean;
  isPinned: boolean;
  category?: string;
}

@Injectable({
  providedIn: 'root'
})
export class CoopStateService {
  private api = inject(ApiService);
  private platformId = inject(PLATFORM_ID);

  doorState = signal<DoorState>(DoorState.CLOSED);
  chickens = signal<Chicken[]>([]);
  totalChickens = signal<number>(10);
  currentTime = signal<string>('');
  weatherForecast = signal<WeatherDay[]>([]);
  sunrise = signal<string>('06:00');
  sunset = signal<string>('18:00');
  distance = signal<number>(45);
  irTriggered = signal<boolean>(false);
  systemOnline = signal<boolean>(true);
  statusMessages = signal<StatusMessage[]>([]);
  isAnalyzing = signal<boolean>(false);
  herdingMode = signal<boolean>(false);
  weatherLock = signal<boolean>(false);
  startTime = signal<string>(new Date().toLocaleString());

  solarTimer = signal<string>('--:--:--');
  solarTimerLabel = signal<string>('Solar Syncing');

  // Settings
  musicDuration = signal<number>(5);
  smartNightLight = signal<boolean>(true);
  musicSignal = signal<boolean>(false);
  isReturning = signal<boolean>(false);
  serviceMode = signal<boolean>(false);
  manualOpenOverride = signal<boolean>(false);
  autoCloseTime = signal<string | null>(null);
  warningCount = computed(() => this.statusMessages().filter(m => m.isWarning).length);
  errorCount = computed(() => this.statusMessages().filter(m => m.isError).length);
  latestCapture = signal<ApiCaptureRow | null>(null);
  private lastManualAction = 0;
  private herdingAttempts = 0;

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return; // SSR guard (M10)

    this.initChickens();
    this.startAnimationLoop();
    this.startTimeSync();

    // Connect to backend
    this.fetchInitialState();
    this.api.connectWebSocket();
    this.subscribeToWsEvents();

    this.addStatusMessage('System initialized. Connecting to backend...', false, false);
  }

  // ── Backend integration ───────────────────────────────────────────────────

  private fetchInitialState() {
    // Fetch settings
    this.api.getSettings().subscribe({
      next: (s) => {
        this.totalChickens.set(s.totalChickens);
        this.serviceMode.set(s.serviceMode);
        this.musicDuration.set(s.musicDuration);
        this.smartNightLight.set(s.smartNightLight);
        this.initChickens();
      },
      error: () => this.systemOnline.set(false),
    });

    // Fetch door state and restore manual override
    this.api.getDoorState().subscribe({
      next: (d) => {
        const state = d.state as DoorState;
        if (Object.values(DoorState).includes(state)) {
          this.doorState.set(state);
          // Restore manual override checkbox from persisted door state
          if (state === DoorState.OPEN || state === DoorState.OPENING) {
            this.manualOpenOverride.set(true);
          }
        }
      },
    });

    // Fetch weather from backend cache
    this.fetchWeather();

    // Fetch latest sensor reading
    this.api.getLatestSensor().subscribe({
      next: (s) => {
        if (s) {
          this.distance.set(s.distanceCm);
          this.irTriggered.set(s.irTriggered);
        }
      },
    });

    // Fetch latest camera capture
    this.api.getLatestCapture().subscribe({
      next: (c) => { if (c) this.latestCapture.set(c); },
    });

    // Health check
    this.api.getHealth().subscribe({
      next: (h) => {
        this.systemOnline.set(h.status === 'ok');
        if (h.status === 'ok') {
          this.addStatusMessage('Backend connected. System online.');
        }
      },
      error: () => {
        this.systemOnline.set(false);
        this.addStatusMessage('Backend unreachable. Running in offline mode.', true, true);
      },
    });
  }

  private subscribeToWsEvents() {
    this.api.wsMessage$.subscribe((msg) => {
      switch (msg.event) {
        case 'door:state_changed': {
          const p = msg.payload as { toState: string };
          const state = p.toState as DoorState;
          if (Object.values(DoorState).includes(state)) {
            this.doorState.set(state);
          }
          break;
        }
        case 'door:command_received': {
          const p = msg.payload as { command: string };
          if (p.command === 'OPEN') this.doorState.set(DoorState.OPENING);
          else if (p.command === 'CLOSE') this.doorState.set(DoorState.CLOSING);
          break;
        }
        case 'sensor:reading': {
          const p = msg.payload as { distanceCm: number; irTriggered: boolean; chickensInside: number; doorState: string };
          this.distance.set(p.distanceCm);
          this.irTriggered.set(p.irTriggered);
          break;
        }
        case 'weather:updated':
          this.fetchWeather();
          break;
        case 'ai:analysis_complete': {
          const p = msg.payload as { analysisText: string; isWarning: boolean; anomalyDetected?: boolean; threatType?: string };
          this.isAnalyzing.set(false);
          this.addStatusMessage(p.analysisText, p.isWarning, p.isWarning);
          if (p.anomalyDetected && p.threatType === 'predator') {
            this.addStatusMessage(`THREAT DETECTED: ${p.threatType}`, false, true, 'VISION_THREAT', true);
          }
          break;
        }
        case 'camera:new_capture':
          this.api.getLatestCapture().subscribe({
            next: (c) => { if (c) this.latestCapture.set(c); },
          });
          break;
        case 'system:alert': {
          const p = msg.payload as { text: string; severity: string; category?: string; isPinned?: boolean };
          this.addStatusMessage(p.text, p.severity === 'error', p.isPinned ?? false, p.category, p.severity === 'error');
          break;
        }
      }
    });
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  addStatusMessage(text: string, isWarning = false, isPinned = false, category?: string, isError = false) {
    const now = new Date();
    const newMessage: StatusMessage = {
      id: Math.random().toString(36).substring(2, 9),
      text,
      timestamp: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      date: now,
      isWarning,
      isError,
      isPinned,
      category
    };

    this.statusMessages.update(prev => [newMessage, ...prev]);
  }

  unpinCategory(category: string) {
    this.statusMessages.update(messages =>
      messages.map(m => m.category === category ? { ...m, isPinned: false, isWarning: false, isError: false } : m)
    );
  }

  getDisplayMessages() {
    const all = this.statusMessages();
    const pinned = all.filter(m => m.isPinned).sort((a, b) => b.date.getTime() - a.date.getTime());
    const unpinned = all.filter(m => !m.isPinned);
    return [...pinned, ...unpinned].slice(0, 10);
  }

  // ── Time + Solar ──────────────────────────────────────────────────────────

  private startTimeSync() {
    const updateTime = () => {
      if (this.serviceMode()) return;
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      this.currentTime.set(timeStr);
      this.updateSolarTimer(now, this.sunrise(), this.sunset());
    };
    updateTime();
    setInterval(updateTime, 1000);
  }

  private updateSolarTimer(now: Date, sunriseStr: string, sunsetStr: string) {
    const sunriseDate = this.parseTime(sunriseStr, now);
    const sunsetDate = this.parseTime(sunsetStr, now);

    let targetDate: Date;
    let label: string;

    if (now < sunriseDate) {
      targetDate = sunriseDate;
      label = 'Time till door opens';
    } else if (now < sunsetDate) {
      targetDate = sunsetDate;
      label = 'Time till door closing';
    } else {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      targetDate = this.parseTime(sunriseStr, tomorrow);
      label = 'Time till door opens';
    }

    this.solarTimerLabel.set(label);
    const diff = targetDate.getTime() - now.getTime();
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    this.solarTimer.set(
      `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    );
  }

  private parseTime(timeStr: string, baseDate: Date) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const d = new Date(baseDate);
    d.setHours(hours, minutes, 0, 0);
    return d;
  }

  // ── Weather (from backend cache) ──────────────────────────────────────────

  private fetchWeather() {
    this.api.getWeatherForecast().subscribe({
      next: (days) => {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const forecast: WeatherDay[] = days.map((d: ApiWeatherDay) => {
          const date = new Date(d.forecastDate + 'T00:00:00');
          return {
            day: dayNames[date.getDay()],
            temp: Math.round(d.tempMax),
            code: d.weatherCode,
            icon: this.getWeatherIcon(d.weatherCode),
          };
        });
        this.weatherForecast.set(forecast);

        // Extract sunrise/sunset from today's data
        const today = days[0];
        if (today?.sunrise) {
          const sr = new Date(today.sunrise);
          const ss = new Date(today.sunset);
          if (!isNaN(sr.getTime())) {
            this.sunrise.set(sr.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }));
          }
          if (!isNaN(ss.getTime())) {
            this.sunset.set(ss.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }));
          }
        }

        // Check for severe weather lock
        if (today?.isSevere && !this.serviceMode()) {
          this.weatherLock.set(true);
          this.addStatusMessage('Severe weather detected. AI has engaged Weather Lockdown.', true, true, 'WEATHER_LOCK');
        }
      },
      error: () => {
        this.weatherForecast.set([
          { day: 'Mon', temp: 18, code: 0, icon: 'wb_sunny' },
          { day: 'Tue', temp: 16, code: 3, icon: 'cloud' },
          { day: 'Wed', temp: 14, code: 61, icon: 'water_drop' },
          { day: 'Thu', temp: 15, code: 3, icon: 'cloud' },
          { day: 'Fri', temp: 19, code: 0, icon: 'wb_sunny' },
        ]);
      },
    });
  }

  private getWeatherIcon(code: number): string {
    if (code === 0) return 'wb_sunny';
    if (code < 4) return 'cloud_queue';
    if (code < 50) return 'cloud';
    if (code < 70) return 'water_drop';
    return 'thunderstorm';
  }

  // ── Door control (via backend) ────────────────────────────────────────────

  async setDoorState(state: DoorState, isManual = true) {
    if (isManual) {
      this.lastManualAction = Date.now();
    } else {
      if (state === DoorState.CLOSED) {
        this.manualOpenOverride.set(false);
      }
    }

    // Map to backend command
    if (state === DoorState.OPEN || state === DoorState.CLOSED) {
      const command = state === DoorState.OPEN ? 'OPEN' as const : 'CLOSE' as const;
      const trigger = isManual ? 'manual' : 'solar';
      const insideCount = this.chickens().filter(c => c.x < 176).length;

      // Optimistic UI update
      this.doorState.set(command === 'OPEN' ? DoorState.OPENING : DoorState.CLOSING);

      if (state === DoorState.OPEN) {
        if (this.weatherLock()) {
          this.weatherLock.set(false);
          this.unpinCategory('WEATHER_LOCK');
          this.addStatusMessage('Weather lockdown overridden by user.', false, false);
        }
      }

      this.api.sendDoorCommand(command, trigger, insideCount).subscribe({
        next: () => {
          this.addStatusMessage(`Door command queued: ${command}`);
        },
        error: () => {
          this.doorState.set(DoorState.ERROR);
          this.addStatusMessage('Failed to send door command to backend.', false, true, undefined, true);
        },
      });
      return;
    }

    // ERROR state — just update locally
    if (state === DoorState.ERROR) {
      this.doorState.set(state);
      this.addStatusMessage('System Error: Door obstruction detected!', false, true, 'SYSTEM_ERROR', true);
    }
  }

  toggleManualOpen() {
    const target = !this.manualOpenOverride();
    this.manualOpenOverride.set(target);
    if (target) {
      this.setDoorState(DoorState.OPEN, true);
    } else {
      this.setDoorState(DoorState.CLOSED, true);
    }
  }

  // ── Chicken animation (visual only — state from backend) ──────────────────

  private initChickens() {
    const initialChickens: Chicken[] = [];
    const count = this.totalChickens();
    for (let i = 0; i < count; i++) {
      const isInside = i < (count * 0.2);
      const x = isInside ? Math.random() * 100 + 40 : Math.random() * 120 + 220;
      const y = Math.random() * 140 + 50;
      initialChickens.push({ id: i, x, y, targetX: x, targetY: y, isInside, type: 'chick' });
    }
    this.chickens.set(initialChickens);
  }

  updateTotalChickens(count: number) {
    this.totalChickens.set(count);
    this.initChickens();
    this.api.putSettings({ totalChickens: count }).subscribe();
  }

  private startAnimationLoop() {
    setInterval(() => this.updateChickens(), 100);
  }

  private updateChickens() {
    if (this.serviceMode()) return;

    const currentState = this.doorState();
    const CHICKEN_RADIUS = 10;
    const FRAME_X_LEFT = 166;
    const FRAME_X_RIGHT = 178;
    const BUFFER = 14;
    const SAFE_X_MIN = FRAME_X_LEFT - BUFFER;
    const SAFE_X_MAX = FRAME_X_RIGHT + BUFFER;
    const DOOR_Y_MIN = 80;
    const DOOR_Y_MAX = 160;

    this.chickens.update(prev => {
      const next = prev.map(c => ({ ...c }));

      for (let i = 0; i < next.length; i++) {
        const c = next[i];

        if (currentState === DoorState.OPEN && Math.random() < 0.005) {
          c.isInside = !c.isInside;
        }

        if (Math.random() < 0.02) {
          if (currentState === DoorState.CLOSED || currentState === DoorState.ERROR) {
            if (c.x < 172) {
              c.targetX = Math.max(30, Math.min(SAFE_X_MIN - 5, c.targetX + (Math.random() - 0.5) * 80));
            } else {
              c.targetX = Math.max(SAFE_X_MAX + 5, Math.min(370, c.targetX + (Math.random() - 0.5) * 80));
            }
          } else {
            c.targetX = Math.max(30, Math.min(370, c.targetX + (Math.random() - 0.5) * 100));
            if (c.targetX > SAFE_X_MIN && c.targetX < SAFE_X_MAX) {
              if (Math.random() < 0.6) {
                c.targetX = (c.x < 172) ? SAFE_X_MIN - 10 : SAFE_X_MAX + 10;
              } else {
                c.targetY = 120;
              }
            }
          }
          c.targetY = Math.max(45, Math.min(205, c.targetY + (Math.random() - 0.5) * 100));
        }

        let moveX = (c.targetX - c.x) * 0.05;
        let moveY = (c.targetY - c.y) * 0.05;
        const nextX = c.x + moveX;
        const nextY = c.y + moveY;
        const inFrameX = nextX > SAFE_X_MIN && nextX < SAFE_X_MAX;
        const inOpeningY = nextY > DOOR_Y_MIN + 12 && nextY < DOOR_Y_MAX - 12;

        if (inFrameX) {
          if (currentState !== DoorState.OPEN || !inOpeningY) {
            moveX = 0;
            if (c.x > SAFE_X_MIN && c.x < SAFE_X_MAX) {
              moveX = (c.x < 172) ? -1.5 : 1.5;
            }
            if (currentState === DoorState.OPEN) {
              moveY = (nextY < 120) ? 1.5 : -1.5;
            }
          }
        }

        c.x += moveX;
        c.y += moveY;

        for (let j = 0; j < next.length; j++) {
          if (i === j) continue;
          const other = next[j];
          const dx = c.x - other.x;
          const dy = c.y - other.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const minDistance = CHICKEN_RADIUS * 2;

          if (dist < minDistance) {
            const angle = Math.atan2(dy, dx);
            const overlap = minDistance - dist;
            const force = overlap * 0.5;
            c.x += Math.cos(angle) * force;
            c.y += Math.sin(angle) * force;
            other.x -= Math.cos(angle) * force;
            other.y -= Math.sin(angle) * force;
          }
        }
      }

      return next;
    });
  }

  manualChickenReturn() {
    this.isReturning.set(true);
    this.unpinCategory('HERDING');
    this.chickens.update(prev => prev.map(c => ({
      ...c,
      isInside: true,
      x: Math.random() * 100 + 40,
      y: Math.random() * 140 + 50,
      targetX: Math.random() * 100 + 40,
      targetY: Math.random() * 140 + 50,
    })));
    this.setDoorState(DoorState.CLOSED, false);
    this.addStatusMessage('Manual chicken return triggered. All chickens secured.', false, false);

    setTimeout(() => this.isReturning.set(false), 3000);
  }

  // ── AI Analysis (via backend Claude API) ──────────────────────────────────

  async runAIAnalysis(context = '') {
    if (this.serviceMode()) return;
    this.isAnalyzing.set(true);

    const insideCount = this.chickens().filter(c => c.x < 176).length;
    const total = this.totalChickens();
    const weather = this.weatherForecast()[0];

    this.api.runAiAnalysis({
      doorState: this.doorState(),
      chickensInside: insideCount,
      totalChickens: total,
      weatherCode: weather?.code,
      tempMax: weather?.temp,
      weatherLock: this.weatherLock(),
      serviceMode: this.serviceMode(),
      obstructionDistance: this.distance(),
      contextNote: context || undefined,
    }).subscribe({
      next: () => {
        // Message is added by the ai:analysis_complete WebSocket broadcast — no duplicate here
        this.isAnalyzing.set(false);
      },
      error: () => {
        // WS won't fire on HTTP error, so add message here only
        this.isAnalyzing.set(false);
        this.addStatusMessage('AI module offline. Manual monitoring advised.', true, true);
      },
    });
  }
}
