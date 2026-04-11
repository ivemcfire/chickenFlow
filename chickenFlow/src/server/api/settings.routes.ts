import { Router } from 'express';
import { db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { ApiSettings } from './types.js';

export const settingsRouter = Router();

settingsRouter.get('/', (_req, res, next) => {
  try {
    const row = db.select().from(settings).where(eq(settings.id, 1)).get();
    if (!row) {
      // Seed defaults on first request
      db.insert(settings).values({ id: 1 }).onConflictDoNothing().run();
      res.json(db.select().from(settings).where(eq(settings.id, 1)).get());
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

settingsRouter.put('/', (req, res, next) => {
  try {
    const body = req.body as Partial<ApiSettings>;
    db.insert(settings)
      .values({
        id: 1,
        totalChickens: body.totalChickens ?? 10,
        serviceMode: body.serviceMode ?? false,
        automaticDoor: body.automaticDoor ?? true,
        musicDuration: body.musicDuration ?? 5,
        smartNightLight: body.smartNightLight ?? true,
        locationLat: body.locationLat ?? 51.5074,
        locationLon: body.locationLon ?? -0.1278,
        updatedAt: new Date().toISOString(),
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
          updatedAt: sql`(datetime('now'))`,
        },
      })
      .run();
    res.json(db.select().from(settings).where(eq(settings.id, 1)).get());
  } catch (err) {
    next(err);
  }
});
