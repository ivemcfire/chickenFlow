import { db } from '../db/index.js';
import { settings, weatherCache, doorEvents, deviceStatus } from '../db/schema.js';
import { desc, eq, sql } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import { publishDoorCommand } from '../services/mqtt-bridge.service.js';
import { localDate } from '../util/local-date.js';

const FAILSAFE_MS = 90 * 60 * 1000;

// Decides whether the door should currently be OPEN (day) or CLOSED (night)
// based on today's sunrise/sunset, then queues a command for the ESP32 if the
// last known door state disagrees. Skipped when service mode is on, severe
// weather is forecast, or a command is already pending.
export async function solarAutomationJob(): Promise<void> {
  const [cfg] = await db.select().from(settings).where(eq(settings.id, 1));
  if (!cfg) return;

  if (cfg.serviceMode) return;
  if (cfg.pendingCommand && cfg.pendingCommand !== 'NONE') return;

  // Manual-override window: the button-triggered 15 min open bypasses solar.
  // When the window just lapsed, this job is responsible for clearing the
  // flag and queuing CLOSE so the coop returns to automatic rule.
  if (cfg.manualOverrideUntil) {
    const overrideMs = cfg.manualOverrideUntil.getTime();
    if (overrideMs > Date.now()) return;

    await db.update(settings)
      .set({ manualOverrideUntil: null, pendingCommand: 'CLOSE' })
      .where(eq(settings.id, 1));

    wsBroadcaster.broadcast('door:command_received', { command: 'CLOSE' });
    wsBroadcaster.broadcast('system:alert', {
      severity: 'info',
      text: 'Manual override expired — door CLOSE queued, automation resumed.',
      category: 'MANUAL_OVERRIDE',
      isPinned: false,
    });
    console.log('[Job:solar-automation] Manual override expired — queued CLOSE');
    return;
  }

  const todayStr = localDate();
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
  let devLightLevel: number | null | undefined;

  if (isDay) {
    if (today.isSevere) return; // weather-poll job handles severe close
    if (doorState !== 'OPEN' && doorState !== 'OPENING') {
      const [dev] = await db.select({ lightLevel: deviceStatus.lightLevel })
        .from(deviceStatus)
        .where(eq(deviceStatus.deviceId, 'esp32-s2-coop'));
      devLightLevel = dev?.lightLevel;

      const msSinceSunrise = now - sunriseMs;
      const lightOk = devLightLevel != null && devLightLevel >= (cfg.lightThreshold ?? 2000);
      const failsafeTripped = msSinceSunrise >= FAILSAFE_MS;

      if (lightOk || failsafeTripped) {
        target = 'OPEN';
        if (failsafeTripped && !lightOk) {
          wsBroadcaster.broadcast('system:alert', {
            severity: 'warning',
            text: 'Light sensor below threshold 90 min past sunrise — opening anyway. LDR may be obstructed (dirt, snow, dropping). Inspect the sensor.',
            category: 'LDR_FAILSAFE',
            isPinned: true,
          });
        }
      } else {
        return; // wait for more light, next tick will re-check
      }
    }
  } else {
    if (doorState !== 'CLOSED' && doorState !== 'CLOSING') target = 'CLOSE';
  }

  if (!target) return;

  await db.update(settings)
    .set({ pendingCommand: target })
    .where(eq(settings.id, 1));

  publishDoorCommand(target, 'solar-auto');
  wsBroadcaster.broadcast('door:command_received', { command: target });
  wsBroadcaster.broadcast('system:alert', {
    severity: 'info',
    text: `Solar automation queued ${target} command (${isDay ? 'day' : 'night'} mode).`,
    category: 'SOLAR_AUTO',
    isPinned: false,
  });

  if (isDay) {
    console.log(`[Job:solar-automation] day mode, doorState=${doorState}, light=${devLightLevel ?? 'n/a'}/${cfg.lightThreshold} → queued ${target}`);
  } else {
    console.log(`[Job:solar-automation] night mode, doorState=${doorState} → queued ${target}`);
  }
}
