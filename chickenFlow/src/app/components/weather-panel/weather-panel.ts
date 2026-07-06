import { ChangeDetectionStrategy, Component, inject, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CoopStore } from '../../coop-store.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-weather-panel',
  imports: [MatIconModule],
  templateUrl: './weather-panel.html',
})
export class WeatherPanelComponent {
  private store = inject(CoopStore);

  weatherForecast = this.store.weatherForecast;

  weatherSubtitle = computed(() => {
    const loc = this.store.weatherLocation;
    const ts = this.store.weatherUpdatedAt();
    const t = ts ? new Date(ts) : null;
    if (!t || isNaN(t.getTime())) return loc;
    const dd = String(t.getDate()).padStart(2, '0');
    const mm = String(t.getMonth() + 1).padStart(2, '0');
    const yyyy = t.getFullYear();
    const hh = String(t.getHours()).padStart(2, '0');
    const mi = String(t.getMinutes()).padStart(2, '0');
    return `${loc} ${dd}/${mm}/${yyyy} ${hh}:${mi}`;
  });
}
