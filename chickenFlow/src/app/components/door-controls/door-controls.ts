import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CoopStore } from '../../coop-store.service';
import { CoopAnimationService } from '../../coop-animation.service';
import { MessagesService } from '../../messages.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-door-controls',
  imports: [MatIconModule],
  templateUrl: './door-controls.html',
})
export class DoorControlsComponent {
  private store = inject(CoopStore);
  private animation = inject(CoopAnimationService);
  private messages = inject(MessagesService);

  doorOpen = this.store.doorOpen;
  weatherLock = this.store.weatherLock;
  isReturning = this.animation.isReturning;

  showResetInfo = signal(false);

  toggleDoorOpen() {
    this.store.toggleDoorOpen();
  }

  toggleResetInfo() {
    this.showResetInfo.update((v) => !v);
  }

  /** Visual reset only — there is no backend endpoint to zero the real
   *  sensor-driven chickensInside count, so this resets the sprite display
   *  and closes the door for safety, same as before the split. */
  manualChickenReturn() {
    this.animation.resetAllInside();
    this.store.closeDoor('manual');
    this.messages.post('All chickens brought back inside.');
  }
}
