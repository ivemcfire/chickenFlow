import { db } from '../db/index.js';
import { settings, weatherCache } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';

// WMO weather codes that trigger severe weather lock
const SEVERE_CODES = new Set([65, 71, 73, 75, 77, 82, 85, 86, 95, 96, 99]);

interface OpenMeteoResponse {
  daily: {
    time: string[];
    weathercode: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    sunrise: string[];
    sunset: string[];
  };
}

export async function fetchAndCacheWeather(): Promise<void> {
  const cfg = db.select().from(settings).where(eq(settings.id, 1)).get();
  const lat = cfg?.locationLat ?? 51.5074;
  const lon = cfg?.locationLon ?? -0.1278;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=auto&forecast_days=5`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);

  const data = await res.json() as OpenMeteoResponse;
  const { time, weathercode, temperature_2m_max, temperature_2m_min, sunrise, sunset } = data.daily;

  const rows = time.map((date, i) => ({
    forecastDate: date,
    weatherCode: weathercode[i]!,
    tempMax: temperature_2m_max[i]!,
    tempMin: temperature_2m_min[i]!,
    sunrise: sunrise[i]!,
    sunset: sunset[i]!,
    isSevere: SEVERE_CODES.has(weathercode[i]!),
    fetchedAt: new Date().toISOString(),
  }));

  for (const row of rows) {
    db.insert(weatherCache)
      .values(row)
      .onConflictDoUpdate({
        target: weatherCache.forecastDate,
        set: {
          weatherCode: sql`excluded.weather_code`,
          tempMax: sql`excluded.temp_max`,
          tempMin: sql`excluded.temp_min`,
          sunrise: sql`excluded.sunrise`,
          sunset: sql`excluded.sunset`,
          isSevere: sql`excluded.is_severe`,
          fetchedAt: sql`(datetime('now'))`,
        },
      })
      .run();
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const today = rows.find((r) => r.forecastDate === todayStr);

  console.log(`[Weather] Cached ${rows.length} forecast days. Today: code=${today?.weatherCode}, severe=${today?.isSevere}`);

  wsBroadcaster.broadcast('weather:updated', {
    today,
    forecast: rows,
    isSevereToday: today?.isSevere ?? false,
  });
}
