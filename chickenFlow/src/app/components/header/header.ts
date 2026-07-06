import { ChangeDetectionStrategy, Component, inject, computed, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CoopStore } from '../../coop-store.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-header',
  imports: [MatIconModule],
  templateUrl: './header.html',
})
export class HeaderComponent {
  private store = inject(CoopStore);

  ldrOnline = this.store.ldrOnline;
  systemOnline = this.store.esp32Online;
  backendOnline = this.store.backendOnline;

  showAbout = signal(false);

  headerStatusLine = computed(() => {
    if (!this.backendOnline()) return 'NO CONNECTION TO THE SERVER';
    if (!this.systemOnline()) return 'NO CONNECTION TO THE COOP CONTROLLER';
    return `RUNNING NORMAL SINCE ${this.store.startTime()}`;
  });

  toggleAbout() {
    this.showAbout.update((v) => !v);
  }
}
