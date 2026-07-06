import { Router } from 'express';
import { db } from '../db/index.js';
import { statusMessages } from '../db/schema.js';
import { desc, eq } from 'drizzle-orm';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import { validate } from '../middleware/validate.js';
import { statusMessageSchema, pinMessageSchema, type StatusMessageBody } from './schemas.js';

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

messagesRouter.post('/', validate(statusMessageSchema), async (req, res, next) => {
  try {
    const body = req.body as StatusMessageBody;
    const [row] = await db.insert(statusMessages).values({
      text: body.text,
      isWarning: body.isWarning ?? false,
      isError: body.isError ?? false,
      isPinned: body.isPinned ?? false,
      category: body.category,
    }).returning();

    wsBroadcaster.broadcast('system:message', row);
    res.status(201).json({ ok: true, id: row!.id });
  } catch (err) {
    next(err);
  }
});

messagesRouter.patch<{ id: string }>('/:id/pin', validate(pinMessageSchema), async (req, res, next) => {
  try {
    const { pin } = req.body as { pin?: boolean };
    await db.update(statusMessages)
      .set({ isPinned: pin ?? true })
      .where(eq(statusMessages.id, Number(req.params['id'])));
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
      .where(eq(statusMessages.id, Number(req.params['id'])));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
