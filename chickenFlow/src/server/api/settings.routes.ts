import { Router } from 'express';
import { db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { ApiSettings } from './types.js';
import { buildSettingsPatch } from './build-settings-patch.js';

export const settingsRouter = Router();

settingsRouter.get('/', async (_req, res, next) => {
  try {
    const [row] = await db.select().from(settings).where(eq(settings.id, 1));
    if (!row) {
      // Seed defaults on first request
      await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
      const [seeded] = await db.select().from(settings).where(eq(settings.id, 1));
      res.json(seeded);
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

settingsRouter.put('/', async (req, res, next) => {
  try {
    const body = req.body as Partial<ApiSettings>;

    // Ensure the single row exists so UPDATE can target it.
    await db.insert(settings).values({ id: 1 }).onConflictDoNothing();

    const patch = buildSettingsPatch(body);
    await db.update(settings).set(patch).where(eq(settings.id, 1));

    const [updated] = await db.select().from(settings).where(eq(settings.id, 1));
    res.json(updated);
  } catch (err) {
    next(err);
  }
});
