import { db } from '../db/index.js';
import { settings, weatherCache, deviceStatus } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import { getDoorState, requestDoorCommand } from '../services/door-state.service.js';
import { localDate } from '../util/local-date.js';

const FAILSAFE_MS = 90 * 60 * 1000;

// Decides whether the door should currently be OPEN (day) or CLOSED (night)
// based on today's sunrise/sunset, then commands the ESP32 over MQTT if the
// last known door state disagrees. Skipped when service mode is on, automatic
// door is disabled, or severe weather is forecast. Duplicate suppression
// (already moving / command in flight) lives in the door-state service.
export async function solarAutomationJob(): Promise<void> {
  const [cfg] = await db.select().from(settings).where(eq(settings.id, 1));
  if (!cfg) return;

  if (cfg.serviceMode) return;
  if (!cfg.automaticDoor) return;

  // Manual-override window: a button- or UI-triggered 15 min open bypasses
  // solar. When the window just lapsed, this job clears the flag and commands
  // CLOSE so the coop returns to automatic rule.
  if (cfg.manualOverrideUntil) {
    const overrideMs = cfg.manualOverrideUntil.getTime();
    if (overrideMs > Date.now()) return;

    await db.update(settings)
      .set({ manualOverrideUntil: null })
      .where(eq(settings.id, 1));

    const result = await requestDoorCommand('CLOSE', 'solar-auto');
    if (result.sent) {
      wsBroadcaster.broadcast('system:alert', {
        severity: 'info',
        text: 'Manual override expired — door CLOSE commanded, automation resumed.',
        category: 'MANUAL_OVERRIDE',
        isPinned: false,
      });
    }
    console.log(`[Job:solar-automation] Manual override expired — CLOSE ${result.sent ? 'sent' : `not sent (${result.reason})`}`);
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

  const doorState = await getDoorState();

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

  const result = await requestDoorCommand(target, 'solar-auto');
  if (!result.sent) {
    if (result.reason === 'mqtt-disconnected') {
      console.warn(`[Job:solar-automation] ${target} not sent — MQTT disconnected`);
    }
    return;
  }

  wsBroadcaster.broadcast('system:alert', {
    severity: 'info',
    text: `Solar automation commanded ${target} (${isDay ? 'day' : 'night'} mode).`,
    category: 'SOLAR_AUTO',
    isPinned: false,
  });

  if (isDay) {
    console.log(`[Job:solar-automation] day mode, doorState=${doorState}, light=${devLightLevel ?? 'n/a'}/${cfg.lightThreshold} → sent ${target}`);
  } else {
    console.log(`[Job:solar-automation] night mode, doorState=${doorState} → sent ${target}`);
  }
}
