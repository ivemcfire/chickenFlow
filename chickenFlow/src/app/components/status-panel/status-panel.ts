import { ChangeDetectionStrategy, Component, inject, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { CoopStore } from '../../coop-store.service';
import { MessagesService } from '../../messages.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-status-panel',
  imports: [MatIconModule, DatePipe],
  templateUrl: './status-panel.html',
})
export class StatusPanelComponent {
  private store = inject(CoopStore);
  private messagesService = inject(MessagesService);

  messages = this.messagesService.displayMessages;
  recentMessages = computed(() => this.messages().slice(0, 3));
  warningCount = this.messagesService.warningCount;
  errorCount = this.messagesService.errorCount;
  isAnalyzing = this.store.isAnalyzing;
  serviceMode = this.store.serviceMode;

  showFullLog = signal(false);

  toggleFullLog() {
    this.showFullLog.update((v) => !v);
  }

  refreshAI() {
    this.store.runAIAnalysis('Manual refresh requested.');
  }
}
