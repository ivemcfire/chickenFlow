import {ChangeDetectionStrategy, Component, inject, computed, signal} from '@angular/core';
import {CommonModule} from '@angular/common';
import {MatIconModule} from '@angular/material/icon';
import {CoopStateService, DoorState} from './coop-state.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [CommonModule, MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  coopService = inject(CoopStateService);
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

  showInfo = signal<boolean>(false);
  showResetInfo = signal<boolean>(false);
  showDisableInfo = signal<boolean>(false);

  insideCount = computed(() => {
    return this.chickens().filter(c => c.x < 176).length; // Coop area boundary (DOOR_X)
  });

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
    this.coopService.smartNightLight.update(v => !v);
  }

  toggleMusic() {
    this.coopService.musicSignal.update(v => !v);
  }

  toggleDisableAll() {
    this.coopService.serviceMode.update(v => {
      const next = !v;
      if (next) {
        this.coopService.addStatusMessage("SYSTEM HALTED: Service Mode active. All automatic functions disabled.", true, true, 'SERVICE_MODE');
      } else {
        this.coopService.unpinCategory('SERVICE_MODE');
        this.coopService.addStatusMessage("SYSTEM RESUMED: Service Mode deactivated.");
      }
      return next;
    });
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
}
