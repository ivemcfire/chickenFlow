import { fetchAndCacheWeather } from '../services/weather.service.js';
import { db } from '../db/index.js';
import { settings, weatherCache, doorEvents } from '../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import { localDate } from '../util/local-date.js';

export async function weatherPollJob(): Promise<void> {
  console.log('[Job:weather-poll] Running');
  try {
    await fetchAndCacheWeather();

    // Check if today is severe and door is currently open → queue close
    const todayStr = localDate();
    const [today] = await db.select().from(weatherCache)
      .where(sql`${weatherCache.forecastDate} = ${todayStr}`);

    if (today?.isSevere) {
      // Respect manual override — the keeper is intentionally holding the door
      // open. Severe weather will be handled by the normal solar tick once the
      // override expires.
      const [cfg] = await db.select({
        serviceMode: settings.serviceMode,
        manualOverrideUntil: settings.manualOverrideUntil,
      }).from(settings).where(eq(settings.id, 1));

      if (cfg?.serviceMode) {
        console.log('[Job:weather-poll] Severe weather but service mode active — skipping auto-close');
        return;
      }
      if (cfg?.manualOverrideUntil && cfg.manualOverrideUntil.getTime() > Date.now()) {
        console.log('[Job:weather-poll] Severe weather but manual override active — skipping auto-close');
        return;
      }

      const [latestDoor] = await db.select({ toState: doorEvents.toState })
        .from(doorEvents)
        .orderBy(desc(doorEvents.createdAt))
        .limit(1);

      if (latestDoor?.toState === 'OPEN' || latestDoor?.toState === 'OPENING') {
        await db.update(settings)
          .set({ pendingCommand: 'CLOSE' })
          .where(eq(settings.id, 1));

        wsBroadcaster.broadcast('system:alert', {
          severity: 'warning',
          text: `Severe weather detected (code ${today.weatherCode}). Door close queued for ESP32.`,
          category: 'WEATHER_LOCK',
          isPinned: true,
        });

        console.log(`[Job:weather-poll] Severe weather (code ${today.weatherCode}) — close command queued`);
      }
    }
  } catch (err) {
    console.error('[Job:weather-poll] Failed:', (err as Error).message);
  }
}
