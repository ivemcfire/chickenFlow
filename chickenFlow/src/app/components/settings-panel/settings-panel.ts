import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CoopStore, DoorState } from '../../coop-store.service';
import { DoorControlsComponent } from '../door-controls/door-controls';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-settings-panel',
  imports: [MatIconModule, DoorControlsComponent],
  templateUrl: './settings-panel.html',
})
export class SettingsPanelComponent {
  private store = inject(CoopStore);

  DoorState = DoorState;

  totalChickens = this.store.totalChickens;
  smartNightLight = this.store.smartNightLight;
  serviceMode = this.store.serviceMode;
  doorState = this.store.doorState;

  // Local-only toggle — there's no backend field for a piezo/music signal
  // yet, so this is an inert switch (unchanged from the pre-split behavior).
  musicSignal = signal(false);

  showDisableInfo = signal(false);

  onTotalChickensChange(event: Event) {
    const val = (event.target as HTMLInputElement).value;
    this.store.setTotalChickens(parseInt(val, 10));
  }

  toggleNightLight() {
    this.store.setSmartNightLight(!this.smartNightLight());
  }

  toggleMusic() {
    this.musicSignal.update((v) => !v);
  }

  toggleDisableAll() {
    this.store.setServiceMode(!this.serviceMode());
  }

  toggleDisableInfo() {
    this.showDisableInfo.update((v) => !v);
  }
}
