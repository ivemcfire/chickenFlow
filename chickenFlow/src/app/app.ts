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
  sunrise = this.coopService.sunrise;
  sunset = this.coopService.sunset;
  solarTimer = this.coopService.solarTimer;
  solarTimerLabel = this.coopService.solarTimerLabel;
  weatherLock = this.coopService.weatherLock;
  startTime = this.coopService.startTime;
  distance = this.coopService.distance;
  systemOnline = this.coopService.systemOnline;
  totalChickens = this.coopService.totalChickens;
  statusMessages = computed(() => this.coopService.getDisplayMessages());
  isAnalyzing = this.coopService.isAnalyzing;

  musicDuration = this.coopService.musicDuration;
  smartNightLight = this.coopService.smartNightLight;
  musicSignal = this.coopService.musicSignal;
  isReturning = this.coopService.isReturning;
  serviceMode = this.coopService.serviceMode;
  manualOpenOverride = this.coopService.manualOpenOverride;
  autoCloseTime = this.coopService.autoCloseTime;
  warningCount = this.coopService.warningCount;
  errorCount = this.coopService.errorCount;
  latestCapture = this.coopService.latestCapture;

  showInfo = signal<boolean>(false);
  showResetInfo = signal<boolean>(false);
  showDisableInfo = signal<boolean>(false);
  isCapturing = signal<boolean>(false);
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
      this.coopService.addStatusMessage("SYSTEM HALTED: Service Mode active. All automatic functions disabled.", true, true, 'SERVICE_MODE');
    } else {
      this.coopService.unpinCategory('SERVICE_MODE');
      this.coopService.addStatusMessage("SYSTEM RESUMED: Service Mode deactivated.");
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

  onTotalChickensChange(event: Event) {
    const val = (event.target as HTMLInputElement).value;
    this.coopService.updateTotalChickens(parseInt(val, 10));
  }

  refreshAI() {
    this.coopService.runAIAnalysis("Manual refresh requested.");
  }

  takeSnapshot() {
    if (this.isCapturing()) return;
    this.isCapturing.set(true);
    this.api.takeSnapshot().subscribe({
      next: () => this.isCapturing.set(false),
      error: () => this.isCapturing.set(false),
    });
  }

  onCamError() {
    this.camError.set(true);
  }

  onCamLoad() {
    this.camError.set(false);
  }
}
