import {ChangeDetectionStrategy, Component, inject, computed, signal, OnInit, OnDestroy, PLATFORM_ID} from '@angular/core';
import {isPlatformBrowser} from '@angular/common';
import {CommonModule} from '@angular/common';
import {MatIconModule} from '@angular/material/icon';
import {CoopStateService, DoorState} from './coop-state.service';
import {ApiService} from './api.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [CommonModule, MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {
  coopService = inject(CoopStateService);
  private api = inject(ApiService);
  private platformId = inject(PLATFORM_ID);
  DoorState = DoorState;

  chickens = this.coopService.chickens;
  doorState = this.coopService.doorState;
  currentTime = this.coopService.currentTime;
  weatherForecast = this.coopService.weatherForecast;
  weatherLocation = this.coopService.weatherLocation;
  weatherUpdatedAt = this.coopService.weatherUpdatedAt;
  doorStatusLabel = computed(() => {
    const st = this.doorState();
    if (st === DoorState.ERROR) return 'ALARM: OBSTRUCTION';

    const opened = st === DoorState.OPEN || st === DoorState.OPENING;
    const doorLabel = opened ? 'OPENED' : 'CLOSED';

    if (this.serviceMode()) {
      return `SYSTEM: SERVICE MODE - DOOR: ${doorLabel}`;
    }

    if (this.manualOpenOverride()) {
      return `SYSTEM: MANUAL MODE - DOOR: ${doorLabel}`;
    }

    const now = new Date();
    const sr = this.parseHHMM(this.sunrise(), now);
    const ss = this.parseHHMM(this.sunset(), now);
    const isDay = now >= sr && now < ss;
    const mode = isDay ? 'DAY MODE' : 'NIGHT MODE';
    return `SYSTEM: ${mode} - DOOR: ${doorLabel}`;
  });

  private parseHHMM(hhmm: string, base: Date): Date {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(base);
    d.setHours(h || 0, m || 0, 0, 0);
    return d;
  }

  weatherSubtitle = computed(() => {
    const loc = this.weatherLocation();
    const ts = this.weatherUpdatedAt();
    const t = ts ? new Date(ts) : null;
    if (!t || isNaN(t.getTime())) return loc;
    const dd = String(t.getDate()).padStart(2, '0');
    const mm = String(t.getMonth() + 1).padStart(2, '0');
    const yyyy = t.getFullYear();
    const hh = String(t.getHours()).padStart(2, '0');
    const mi = String(t.getMinutes()).padStart(2, '0');
    return `${loc} ${dd}/${mm}/${yyyy} ${hh}:${mi}`;
  });
  sunrise = this.coopService.sunrise;
  sunset = this.coopService.sunset;
  solarTimer = this.coopService.solarTimer;
  solarTimerLabel = this.coopService.solarTimerLabel;
  weatherLock = this.coopService.weatherLock;
  startTime = this.coopService.startTime;
  systemOnline = this.coopService.systemOnline;
  backendOnline = this.coopService.backendOnline;
  headerStatusLine = computed(() => {
    if (!this.backendOnline()) return 'NO CONNECTION TO THE SERVER';
    if (!this.systemOnline()) return 'NO CONNECTION TO THE COOP CONTROLLER';
    return `RUNNING NORMAL SINCE ${this.startTime()}`;
  });
  totalChickens = this.coopService.totalChickens;
  statusMessages = computed(() => this.coopService.getDisplayMessages());
  isAnalyzing = this.coopService.isAnalyzing;

  musicDuration = this.coopService.musicDuration;
  smartNightLight = this.coopService.smartNightLight;
  musicSignal = this.coopService.musicSignal;
  isReturning = this.coopService.isReturning;
  serviceMode = this.coopService.serviceMode;
  manualOpenOverride = this.coopService.manualOpenOverride;
  manualOverrideExpiresAt = this.coopService.manualOverrideExpiresAt;
  manualOverrideMinutesLeft = computed(() => {
    this.currentTime();
    const expiresAt = this.manualOverrideExpiresAt();
    if (!expiresAt) return null;
    const diffMs = expiresAt - Date.now();
    if (diffMs <= 0) return 0;
    return Math.ceil(diffMs / 60000);
  });
  autoCloseTime = this.coopService.autoCloseTime;
  warningCount = this.coopService.warningCount;
  errorCount = this.coopService.errorCount;
  showInfo = signal<boolean>(false);
  showResetInfo = signal<boolean>(false);
  showDisableInfo = signal<boolean>(false);
  showFullLog = signal<boolean>(false);
  showAbout = signal<boolean>(false);
  camError = signal<boolean>(false);

  // Timestamp-busted URL polled every 2 s for near-live view
  private camTs = signal<number>(Date.now());
  camSnapshotUrl = computed(() => `/api/camera/snapshot?t=${this.camTs()}`);
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  insideCount = computed(() => {
    return this.chickens().filter(c => c.x < 176).length; // Coop area boundary (DOOR_X)
  });

  ngOnInit() {
    if (isPlatformBrowser(this.platformId)) {
      this.pollTimer = setInterval(() => this.camTs.set(Date.now()), 2000);
    }
  }

  ngOnDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  setDoorState(state: DoorState) {
    this.coopService.setDoorState(state);
  }

  toggleManualOpen() {
    this.coopService.toggleManualOpen();
  }

  manualChickenReturn() {
    this.coopService.manualChickenReturn();
  }

  toggleNightLight() {
    const next = !this.coopService.smartNightLight();
    this.coopService.smartNightLight.set(next);
    this.api.putSettings({ smartNightLight: next }).subscribe();
  }

  toggleMusic() {
    this.coopService.musicSignal.update(v => !v);
  }

  toggleDisableAll() {
    const next = !this.coopService.serviceMode();
    this.coopService.serviceMode.set(next);
    if (next) {
      this.coopService.addStatusMessage('Service Mode ON — automatic door is paused.', true, true, 'SERVICE_MODE');
    } else {
      this.coopService.unpinCategory('SERVICE_MODE');
      this.coopService.addStatusMessage('Service Mode OFF — automatic door resumed.');
    }
    this.api.putSettings({ serviceMode: next }).subscribe();
  }

  toggleInfo() {
    this.showInfo.update((v: boolean) => !v);
  }

  toggleResetInfo() {
    this.showResetInfo.update((v: boolean) => !v);
  }

  toggleDisableInfo() {
    this.showDisableInfo.update((v: boolean) => !v);
  }

  toggleFullLog() {
    this.showFullLog.update((v: boolean) => !v);
  }

  toggleAbout() {
    this.showAbout.update((v: boolean) => !v);
  }

  onTotalChickensChange(event: Event) {
    const val = (event.target as HTMLInputElement).value;
    this.coopService.updateTotalChickens(parseInt(val, 10));
  }

  refreshAI() {
    this.coopService.runAIAnalysis("Manual refresh requested.");
  }

  onCamError() {
    this.camError.set(true);
  }

  onCamLoad() {
    this.camError.set(false);
  }
}
