import cron from 'node-cron';
import { weatherPollJob } from './weather-poll.job.js';
import { aiAnalysisJob } from './ai-analysis.job.js';
import { messageCleanupJob } from './message-cleanup.job.js';
import { esp32HeartbeatJob } from './esp32-heartbeat.job.js';

export function startScheduler(): void {
  cron.schedule('*/15 * * * *', () => { void weatherPollJob(); }, { name: 'weather-poll' });
  cron.schedule('3 * * * *', () => { void aiAnalysisJob(); }, { name: 'ai-analysis' });
  cron.schedule('0 3 * * *', () => { void messageCleanupJob(); }, { name: 'message-cleanup' });
  cron.schedule('* * * * *', () => { void esp32HeartbeatJob(); }, { name: 'esp32-heartbeat' });

  console.log('[Scheduler] Jobs registered: weather-poll (*/15m), ai-analysis (hourly @:03), message-cleanup (03:00), esp32-heartbeat (*/1m)');

  void weatherPollJob();
  void esp32HeartbeatJob();
}
