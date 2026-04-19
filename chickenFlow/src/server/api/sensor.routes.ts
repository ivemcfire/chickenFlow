import { Router } from 'express';
import { db } from '../db/index.js';
import { sensorReadings, settings, doorEvents, statusMessages } from '../db/schema.js';
import { desc, eq } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import { markEsp32Online, getEsp32Status } from '../jobs/esp32-heartbeat.job.js';
import type { SensorReadingRequest, ObstructionCheckRequest, ObstructionCheckResponse } from './types.js';

const MANUAL_OVERRIDE_DURATION_MS = 15 * 60 * 1000;

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

    await db.insert(sensorReadings).values({
      topSensorTriggered: body.topSensorTriggered ?? false,
      irTriggered: body.irTriggered ?? false,
      irATriggered: body.irATriggered ?? false,
      irBTriggered: body.irBTriggered ?? false,
      chickensInside: clampedInside,
      totalChickens,
      doorState: body.doorState,
    });

    wsBroadcaster.broadcast('sensor:reading', {
      topSensorTriggered: body.topSensorTriggered ?? false,
      irTriggered: body.irTriggered ?? false,
      irATriggered: body.irATriggered ?? false,
      irBTriggered: body.irBTriggered ?? false,
      chickensInside: clampedInside,
      doorState: body.doorState,
    });

    await markEsp32Online();
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

// ── ESP32 command poll ────────────────────────────────────────────────────────
// Reads and resets pendingCommand inside a transaction to prevent double-delivery.
// Also returns the current `serviceMode` so the ESP32 can mirror the state LED
// and reminder chirps without ever issuing a POST to sync.
sensorRouter.get('/command', async (_req, res, next) => {
  try {
    await markEsp32Online();
    const { action, serviceMode } = await db.transaction(async (tx) => {
      const [row] = await tx.select({
        pendingCommand: settings.pendingCommand,
        serviceMode: settings.serviceMode,
      })
        .from(settings)
        .where(eq(settings.id, 1));
      const cmd = row?.pendingCommand ?? 'NONE';
      const svc = row?.serviceMode ?? false;
      if (cmd !== 'NONE') {
        await tx.update(settings)
          .set({ pendingCommand: 'NONE' })
          .where(eq(settings.id, 1));
      }
      return { action: cmd, serviceMode: svc };
    });

    res.json({ action, serviceMode, delay: 0 });
  } catch (err) {
    next(err);
  }
});

// ── Manual push-button on ESP32 ───────────────────────────────────────────────
// Only mutation path for button-driven state. Poll `/command` returns but never
// changes `serviceMode` — keeping this split avoids poll→POST feedback loops
// and means a mid-press crash leaves backend state untouched.
//
// Both thresholds are toggles:
//   type=override (5 s press)
//     • door CLOSED → OPEN + manualOverrideUntil = now + 15 min
//     • door OPEN   → CLOSE + clear override (returns to automation)
//     Never touches serviceMode — that's the 10 s press's job.
//   type=service (10 s press)
//     • toggles serviceMode, also toggles door (CLOSED→OPEN, OPEN→CLOSE)
//     • always clears manualOverrideUntil
//
// Door-state decision uses the latest door_events row (same pattern as the
// solar job); OPENING/CLOSING counts as already-heading-that-way so rapid
// button mashing doesn't reverse an in-progress movement.
sensorRouter.post('/manual-button', async (req, res, next) => {
  try {
    const body = req.body as { type?: string };
    const type = body.type;

    if (type !== 'override' && type !== 'service') {
      res.status(400).json({ ok: false, error: 'type must be "override" or "service"' });
      return;
    }

    await markEsp32Online();

    const [latest] = await db.select({ toState: doorEvents.toState })
      .from(doorEvents)
      .orderBy(desc(doorEvents.createdAt))
      .limit(1);
    const doorOpenish = latest?.toState === 'OPEN' || latest?.toState === 'OPENING';

    if (type === 'override') {
      if (doorOpenish) {
        await db.update(settings)
          .set({ pendingCommand: 'CLOSE', manualOverrideUntil: null })
          .where(eq(settings.id, 1));

        const text = 'Manual override cancelled via physical button — door closing, automation resumed.';
        await db.insert(statusMessages).values({
          id: `manual-override-cancel-${Date.now()}`,
          text,
          timestamp: new Date().toISOString(),
          isWarning: false,
          category: 'MANUAL_OVERRIDE',
        });
        wsBroadcaster.broadcast('door:command_received', { command: 'CLOSE' });
        wsBroadcaster.broadcast('system:alert', {
          severity: 'info', text, category: 'MANUAL_OVERRIDE', isPinned: false,
        });

        res.status(201).json({ ok: true, type, action: 'CLOSE' });
        return;
      }

      const until = new Date(Date.now() + MANUAL_OVERRIDE_DURATION_MS);
      await db.update(settings)
        .set({ pendingCommand: 'OPEN', manualOverrideUntil: until })
        .where(eq(settings.id, 1));

      const text = 'Manual override via physical button — door opening for 15 minutes.';
      await db.insert(statusMessages).values({
        id: `manual-override-${Date.now()}`,
        text,
        timestamp: new Date().toISOString(),
        isWarning: true,
        category: 'MANUAL_OVERRIDE',
      });
      wsBroadcaster.broadcast('door:command_received', { command: 'OPEN' });
      wsBroadcaster.broadcast('system:alert', {
        severity: 'warning', text, category: 'MANUAL_OVERRIDE', isPinned: false,
      });

      res.status(201).json({ ok: true, type, action: 'OPEN', manualOverrideUntil: until.toISOString() });
      return;
    }

    // type === 'service' — toggle both serviceMode and door.
    const [cfg] = await db.select({ serviceMode: settings.serviceMode })
      .from(settings).where(eq(settings.id, 1));
    const nextServiceMode = !(cfg?.serviceMode ?? false);
    const nextCmd: 'OPEN' | 'CLOSE' = doorOpenish ? 'CLOSE' : 'OPEN';

    await db.update(settings)
      .set({
        serviceMode: nextServiceMode,
        pendingCommand: nextCmd,
        manualOverrideUntil: null,
      })
      .where(eq(settings.id, 1));

    const text = nextServiceMode
      ? `Service mode enabled via physical button — automation paused, door ${nextCmd === 'OPEN' ? 'opening' : 'closing'}.`
      : `Service mode disabled via physical button — automation resumed, door ${nextCmd === 'OPEN' ? 'opening' : 'closing'}.`;
    await db.insert(statusMessages).values({
      id: `service-mode-${Date.now()}`,
      text,
      timestamp: new Date().toISOString(),
      isWarning: nextServiceMode,
      isPinned: nextServiceMode,
      category: 'SERVICE_MODE',
    });
    wsBroadcaster.broadcast('door:command_received', { command: nextCmd });
    wsBroadcaster.broadcast('system:alert', {
      severity: nextServiceMode ? 'warning' : 'info',
      text,
      category: 'SERVICE_MODE',
      isPinned: nextServiceMode,
    });

    res.status(201).json({ ok: true, type, serviceMode: nextServiceMode, action: nextCmd });
  } catch (err) {
    next(err);
  }
});
