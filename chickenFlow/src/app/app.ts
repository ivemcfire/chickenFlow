import { ChangeDetectionStrategy, Component } from '@angular/core';
import { HeaderComponent } from './components/header/header';
import { StatusPanelComponent } from './components/status-panel/status-panel';
import { CoopVisualizationComponent } from './components/coop-visualization/coop-visualization';
import { CameraPanelComponent } from './components/camera-panel/camera-panel';
import { WeatherPanelComponent } from './components/weather-panel/weather-panel';
import { SettingsPanelComponent } from './components/settings-panel/settings-panel';

// The root shell is now pure composition — all state lives in CoopStore /
// CoopAnimationService / MessagesService, and every section of the old
// single template is its own standalone component.
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [
    HeaderComponent,
    StatusPanelComponent,
    CoopVisualizationComponent,
    CameraPanelComponent,
    WeatherPanelComponent,
    SettingsPanelComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {}
