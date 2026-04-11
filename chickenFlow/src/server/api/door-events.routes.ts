import { Router } from 'express';
import { db } from '../db/index.js';
import { doorEvents, settings } from '../db/schema.js';
import { desc, eq } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import type { DoorCommandRequest } from './types.js';

export const doorEventsRouter = Router();

doorEventsRouter.get('/state', (_req, res, next) => {
  try {
    const latest = db.select({ toState: doorEvents.toState })
      .from(doorEvents)
      .orderBy(desc(doorEvents.createdAt))
      .limit(1)
      .get();
    res.json({ state: latest?.toState ?? 'UNKNOWN' });
  } catch (err) {
    next(err);
  }
});

doorEventsRouter.get('/events', (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query['limit'] ?? 50), 200);
    const rows = db.select().from(doorEvents)
      .orderBy(desc(doorEvents.createdAt))
      .limit(limit)
      .all();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

doorEventsRouter.post('/command', (req, res, next) => {
  try {
    const body = req.body as DoorCommandRequest;
    if (!body.command || !['OPEN', 'CLOSE'].includes(body.command)) {
      res.status(400).json({ error: 'BadRequest', message: 'command must be OPEN or CLOSE', statusCode: 400 });
      return;
    }

    // Get current door state for the from_state
    const current = db.select({ toState: doorEvents.toState })
      .from(doorEvents)
      .orderBy(desc(doorEvents.createdAt))
      .limit(1)
      .get();

    const newState = body.command === 'OPEN' ? 'OPENING' : 'CLOSING';

    db.insert(doorEvents).values({
      fromState: current?.toState ?? 'UNKNOWN',
      toState: newState,
      trigger: body.trigger ?? 'manual',
      isManual: (body.trigger ?? 'manual') === 'manual',
      chickensInside: body.chickensInside,
      obstructionDistance: body.obstructionDistance,
    }).run();

    // Queue command for ESP32 poll
    db.update(settings)
      .set({ pendingCommand: body.command })
      .where(eq(settings.id, 1))
      .run();

    wsBroadcaster.broadcast('door:command_received', {
      command: body.command,
      trigger: body.trigger ?? 'manual',
      isManual: (body.trigger ?? 'manual') === 'manual',
    });

    res.status(201).json({ queued: body.command });
  } catch (err) {
    next(err);
  }
});
