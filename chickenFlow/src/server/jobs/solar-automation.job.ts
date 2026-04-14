import { db } from '../db/index.js';
import { settings, weatherCache, doorEvents } from '../db/schema.js';
import { desc, eq, sql } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';

// Decides whether the door should currently be OPEN (day) or CLOSED (night)
// based on today's sunrise/sunset, then queues a command for the ESP32 if the
// last known door state disagrees. Skipped when service mode is on, severe
// weather is forecast, or a command is already pending.
export async function solarAutomationJob(): Promise<void> {
  const [cfg] = await db.select().from(settings).where(eq(settings.id, 1));
  if (!cfg) return;

  if (cfg.serviceMode) return;
  if (cfg.pendingCommand && cfg.pendingCommand !== 'NONE') return;

  const todayStr = new Date().toISOString().split('T')[0];
  const [today] = await db.select().from(weatherCache)
    .where(sql`${weatherCache.forecastDate} = ${todayStr}`);

  if (!today?.sunrise || !today?.sunset) return;

  const now = Date.now();
  const sunriseMs = new Date(today.sunrise).getTime();
  const sunsetMs = new Date(today.sunset).getTime();
  const isDay = now >= sunriseMs && now < sunsetMs;

  const [latest] = await db.select({ toState: doorEvents.toState })
    .from(doorEvents)
    .orderBy(desc(doorEvents.createdAt))
    .limit(1);
  const doorState = latest?.toState ?? 'CLOSED';

  let target: 'OPEN' | 'CLOSE' | null = null;

  if (isDay) {
    if (today.isSevere) return; // weather-poll job handles severe close
    if (doorState !== 'OPEN' && doorState !== 'OPENING') target = 'OPEN';
  } else {
    if (doorState !== 'CLOSED' && doorState !== 'CLOSING') target = 'CLOSE';
  }

  if (!target) return;

  await db.update(settings)
    .set({ pendingCommand: target })
    .where(eq(settings.id, 1));

  wsBroadcaster.broadcast('door:command_received', { command: target });
  wsBroadcaster.broadcast('system:alert', {
    severity: 'info',
    text: `Solar automation queued ${target} command (${isDay ? 'day' : 'night'} mode).`,
    category: 'SOLAR_AUTO',
    isPinned: false,
  });

  console.log(`[Job:solar-automation] ${isDay ? 'day' : 'night'} mode, doorState=${doorState} → queued ${target}`);
}
