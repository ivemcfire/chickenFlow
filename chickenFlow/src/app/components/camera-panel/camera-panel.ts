import { ChangeDetectionStrategy, Component, OnInit, OnDestroy, signal, computed, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-camera-panel',
  imports: [MatIconModule],
  templateUrl: './camera-panel.html',
})
export class CameraPanelComponent implements OnInit, OnDestroy {
  private platformId = inject(PLATFORM_ID);

  cameraOnline = signal(true);
  camError = signal(false);

  // Timestamp-busted URL polled every 2 s for a near-live view.
  private camTs = signal(Date.now());
  camSnapshotUrl = computed(() => `/api/camera/snapshot?t=${this.camTs()}`);
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit() {
    if (isPlatformBrowser(this.platformId)) {
      this.pollTimer = setInterval(() => this.camTs.set(Date.now()), 2000);
    }
  }

  ngOnDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  onCamError() {
    this.camError.set(true);
    this.cameraOnline.set(false);
  }

  onCamLoad() {
    this.camError.set(false);
    this.cameraOnline.set(true);
  }
}
