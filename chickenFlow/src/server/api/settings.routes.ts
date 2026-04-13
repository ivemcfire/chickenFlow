import { Router } from 'express';
import { db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { ApiSettings } from './types.js';

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
    await db.insert(settings)
      .values({
        id: 1,
        totalChickens: body.totalChickens ?? 10,
        serviceMode: body.serviceMode ?? false,
        automaticDoor: body.automaticDoor ?? true,
        musicDuration: body.musicDuration ?? 5,
        smartNightLight: body.smartNightLight ?? true,
        locationLat: body.locationLat ?? 51.5074,
        locationLon: body.locationLon ?? -0.1278,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: settings.id,
        set: {
          totalChickens: sql`excluded.total_chickens`,
          serviceMode: sql`excluded.service_mode`,
          automaticDoor: sql`excluded.automatic_door`,
          musicDuration: sql`excluded.music_duration`,
          smartNightLight: sql`excluded.smart_night_light`,
          locationLat: sql`excluded.location_lat`,
          locationLon: sql`excluded.location_lon`,
          updatedAt: sql`now()`,
        },
      });
    const [updated] = await db.select().from(settings).where(eq(settings.id, 1));
    res.json(updated);
  } catch (err) {
    next(err);
  }
});
