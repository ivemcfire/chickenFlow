import { Router } from 'express';
import { db } from '../db/index.js';
import { sensorReadings, settings, doorEvents } from '../db/schema.js';
import { desc, eq } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import type { SensorReadingRequest } from './types.js';

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

    await db.insert(sensorReadings).values({
      distanceCm: body.distanceCm ?? null,
      topSensorTriggered: body.topSensorTriggered ?? false,
      irTriggered: body.irTriggered ?? false,
      chickensInside: body.chickensInside,
      totalChickens,
      doorState: body.doorState,
    });

    wsBroadcaster.broadcast('sensor:reading', {
      distanceCm: body.distanceCm ?? null,
      topSensorTriggered: body.topSensorTriggered ?? false,
      irTriggered: body.irTriggered ?? false,
      chickensInside: body.chickensInside,
      doorState: body.doorState,
    });

    res.status(201).json({ ok: true });
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

// ── ESP32 command poll ────────────────────────────────────────────────────────
// Reads and resets pendingCommand inside a transaction to prevent double-delivery.
sensorRouter.get('/command', async (_req, res, next) => {
  try {
    const action = await db.transaction(async (tx) => {
      const [row] = await tx.select({ pendingCommand: settings.pendingCommand })
        .from(settings)
        .where(eq(settings.id, 1));
      const cmd = row?.pendingCommand ?? 'NONE';
      if (cmd !== 'NONE') {
        await tx.update(settings)
          .set({ pendingCommand: 'NONE' })
          .where(eq(settings.id, 1));
      }
      return cmd;
    });

    res.json({ action, delay: 0 });
  } catch (err) {
    next(err);
  }
});
