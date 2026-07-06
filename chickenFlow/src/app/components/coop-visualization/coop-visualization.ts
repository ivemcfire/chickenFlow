import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CoopStore, DoorState } from '../../coop-store.service';
import { CoopAnimationService } from '../../coop-animation.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-coop-visualization',
  imports: [MatIconModule],
  templateUrl: './coop-visualization.html',
})
export class CoopVisualizationComponent {
  private store = inject(CoopStore);
  private animation = inject(CoopAnimationService);

  DoorState = DoorState;

  chickens = this.animation.chickens;
  doorState = this.store.doorState;
  doorStatusLabel = this.store.doorStatusLabel;
  doorOpen = this.store.doorOpen;
  serviceMode = this.store.serviceMode;
  manualOverrideMinutesLeft = this.store.manualOverrideMinutesLeft;
  smartNightLight = this.store.smartNightLight;
  chickensInside = this.store.chickensInside;
  totalChickens = this.store.totalChickens;
  doorOpenTime = this.store.doorOpenTime;
  doorCloseTime = this.store.doorCloseTime;
  solarCountdown = this.store.solarCountdown;
  ir1 = this.store.ir1;
  ir2 = this.store.ir2;
  systemOnline = this.store.esp32Online;
}
