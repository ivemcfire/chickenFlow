import cron from 'node-cron';
import { weatherPollJob } from './weather-poll.job.js';
import { aiAnalysisJob } from './ai-analysis.job.js';
import { messageCleanupJob } from './message-cleanup.job.js';

export function startScheduler(): void {
  // Weather every 15 minutes
  cron.schedule('*/15 * * * *', () => { void weatherPollJob(); }, { name: 'weather-poll' });

  // AI hourly at :03 (offset avoids collision with weather poll)
  cron.schedule('3 * * * *', () => { void aiAnalysisJob(); }, { name: 'ai-analysis' });

  // Daily cleanup at 03:00
  cron.schedule('0 3 * * *', () => messageCleanupJob(), { name: 'message-cleanup' });

  console.log('[Scheduler] Jobs registered: weather-poll (*/15m), ai-analysis (hourly @:03), message-cleanup (03:00)');

  // Run weather fetch immediately on startup so the DB isn't empty
  void weatherPollJob();
}
