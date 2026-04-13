import { fetchAndCacheWeather } from '../services/weather.service.js';
import { db } from '../db/index.js';
import { settings, weatherCache, doorEvents } from '../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';

export async function weatherPollJob(): Promise<void> {
  console.log('[Job:weather-poll] Running');
  try {
    await fetchAndCacheWeather();

    // Check if today is severe and door is currently open → queue close
    const todayStr = new Date().toISOString().split('T')[0];
    const [today] = await db.select().from(weatherCache)
      .where(sql`${weatherCache.forecastDate} = ${todayStr}`);

    if (today?.isSevere) {
      const [latestDoor] = await db.select({ toState: doorEvents.toState })
        .from(doorEvents)
        .orderBy(desc(doorEvents.createdAt))
        .limit(1);

      if (latestDoor?.toState === 'OPEN') {
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
