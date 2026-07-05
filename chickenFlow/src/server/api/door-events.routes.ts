import { Router } from 'express';
import { db } from '../db/index.js';
import { doorEvents } from '../db/schema.js';
import { desc } from 'drizzle-orm';
import { getDoorState, requestDoorCommand } from '../services/door-state.service.js';
import { validate } from '../middleware/validate.js';
import { doorCommandSchema, type DoorCommandBody } from './schemas.js';

export const doorEventsRouter = Router();

doorEventsRouter.get('/state', async (_req, res, next) => {
  try {
    res.json({ state: await getDoorState() });
  } catch (err) {
    next(err);
  }
});

doorEventsRouter.get('/events', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query['limit'] ?? 50), 200);
    const rows = await db.select().from(doorEvents)
      .orderBy(desc(doorEvents.createdAt))
      .limit(limit);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Requests a door move over MQTT. The device confirms via coop/door/status —
// door_events is only written when that confirmation arrives, so a dark
// device means no fake OPENING/CLOSING rows.
doorEventsRouter.post('/command', validate(doorCommandSchema), async (req, res, next) => {
  try {
    const body = req.body as DoorCommandBody;
    const trigger = body.trigger ?? 'manual';
    const result = await requestDoorCommand(body.command, trigger, {
      manualOverride: trigger === 'manual',
    });

    if (!result.sent && result.reason === 'mqtt-disconnected') {
      res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'MQTT broker unreachable — command not delivered',
        statusCode: 503,
      });
      return;
    }

    res.status(result.sent ? 202 : 200).json({
      sent: result.sent,
      reason: result.reason,
      command: body.command,
    });
  } catch (err) {
    next(err);
  }
});
