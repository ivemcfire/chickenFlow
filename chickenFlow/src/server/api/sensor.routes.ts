import { Router } from 'express';
import { db } from '../db/index.js';
import { sensorReadings, settings, doorEvents } from '../db/schema.js';
import { desc, eq } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import { markEsp32Online, getEsp32Status } from '../jobs/esp32-heartbeat.job.js';
import type { SensorReadingRequest, ObstructionCheckRequest, ObstructionCheckResponse } from './types.js';

export const sensorRouter = Router();

// ── Sensor reading from ESP32-S2 Mini ────────────────────────────────────────
sensorRouter.post('/sensor', async (req, res, next) => {
  try {
    const body = req.body as SensorReadingRequest;

    // ESP32 sends totalChickens=0 — fill from settings
    let totalChickens = body.totalChickens;
    if (!totalChickens) {
      const [row] = await db.select({ totalChickens: settings.totalChickens })
        .from(settings).where(eq(settings.id, 1));
      totalChickens = row?.totalChickens ?? 10;
    }

    // Clamp chickensInside to [0, totalChickens] — ESP32 IR counter can drift
    const rawInside = body.chickensInside;
    const clampedInside = Math.max(0, Math.min(rawInside, totalChickens));
    if (rawInside > totalChickens) {
      console.warn(`[sensor] Drift detected: chickensInside=${rawInside} exceeds totalChickens=${totalChickens}; clamped to ${clampedInside}`);
    }

    // Firmware sends ir1/ir2 as aliases for irATriggered/irBTriggered — accept either.
    const irA = body.irATriggered ?? body.ir1 ?? false;
    const irB = body.irBTriggered ?? body.ir2 ?? false;

    await db.insert(sensorReadings).values({
      topSensorTriggered: body.topSensorTriggered ?? false,
      irTriggered: body.irTriggered ?? false,
      irATriggered: irA,
      irBTriggered: irB,
      chickensInside: clampedInside,
      totalChickens,
      doorState: body.doorState,
    });

    wsBroadcaster.broadcast('sensor:reading', {
      topSensorTriggered: body.topSensorTriggered ?? false,
      irTriggered: body.irTriggered ?? false,
      irATriggered: irA,
      irBTriggered: irB,
      chickensInside: clampedInside,
      doorState: body.doorState,
      direction: body.direction,
      lightLevel: body.lightLevel,
    });

    await markEsp32Online(
      typeof body.lightLevel === 'number' ? { lightLevel: body.lightLevel } : undefined,
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

sensorRouter.get('/status', async (_req, res, next) => {
  try {
    res.json(await getEsp32Status());
  } catch (err) {
    next(err);
  }
});

sensorRouter.get('/latest', async (_req, res, next) => {
  try {
    const [row] = await db.select().from(sensorReadings)
      .orderBy(desc(sensorReadings.createdAt))
      .limit(1);
    res.json(row ?? null);
  } catch (err) {
    next(err);
  }
});

// ── Door event from ESP32-S2 Mini ─────────────────────────────────────────────
sensorRouter.post('/door-event', async (req, res, next) => {
  try {
    const body = req.body as { fromState: string; toState: string; chickensInside?: number };
    await db.insert(doorEvents).values({
      fromState: body.fromState,
      toState: body.toState,
      trigger: 'esp32',
      isManual: false,
      chickensInside: body.chickensInside,
    });

    wsBroadcaster.broadcast('door:state_changed', {
      fromState: body.fromState,
      toState: body.toState,
      trigger: 'esp32',
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Obstruction-check (hardware-authoritative) ────────────────────────────────
// ESP32 calls this after INA219 detects a motor current stall. Hardware is now
// fully authoritative for obstruction detection — always returns abort: false so
// the firmware follows its own dual-IR + motor-stall logic without AI override.
sensorRouter.post('/obstruction-check', (req, res) => {
  void (req.body as ObstructionCheckRequest);
  const response: ObstructionCheckResponse = {
    abort: false,
    confidence: 0,
    reason: 'hardware-authoritative',
  };
  res.json(response);
});
