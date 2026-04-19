import { Router } from 'express';
import { db } from '../db/index.js';
import { statusMessages } from '../db/schema.js';
import { desc, eq } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import type { StatusMessageRequest } from './types.js';

export const messagesRouter = Router();

messagesRouter.get('/', async (_req, res, next) => {
  try {
    // Pinned first, then recent 50 non-pinned
    const pinned = await db.select().from(statusMessages)
      .where(eq(statusMessages.isPinned, true))
      .orderBy(desc(statusMessages.createdAt));
    const recent = await db.select().from(statusMessages)
      .where(eq(statusMessages.isPinned, false))
      .orderBy(desc(statusMessages.createdAt))
      .limit(50);
    res.json([...pinned, ...recent]);
  } catch (err) {
    next(err);
  }
});

messagesRouter.post('/', async (req, res, next) => {
  try {
    const body = req.body as StatusMessageRequest;
    if (!body.id || !body.text) {
      res.status(400).json({ error: 'BadRequest', message: 'id and text are required', statusCode: 400 });
      return;
    }
    await db.insert(statusMessages).values({
      id: body.id,
      text: body.text,
      timestamp: body.timestamp,
      isWarning: body.isWarning ?? false,
      isError: body.isError ?? false,
      isPinned: body.isPinned ?? false,
      category: body.category,
    });

    wsBroadcaster.broadcast('system:message', body);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

messagesRouter.patch('/:id/pin', async (req, res, next) => {
  try {
    const { pin } = req.body as { pin: boolean };
    await db.update(statusMessages)
      .set({ isPinned: pin ?? true })
      .where(eq(statusMessages.id, req.params['id']!));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

messagesRouter.patch('/category/:cat/unpin', async (req, res, next) => {
  try {
    await db.update(statusMessages)
      .set({ isPinned: false, isWarning: false })
      .where(eq(statusMessages.category, req.params['cat']!));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

messagesRouter.delete('/:id', async (req, res, next) => {
  try {
    await db.delete(statusMessages)
      .where(eq(statusMessages.id, req.params['id']!));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
