import { Router } from 'express';
import { db } from '../db/index.js';
import { weatherCache } from '../db/schema.js';
import { gte, sql } from 'drizzle-orm';

export const weatherRouter = Router();

weatherRouter.get('/today', (_req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const row = db.select().from(weatherCache)
      .where(sql`${weatherCache.forecastDate} = ${today}`)
      .get();
    res.json(row ?? null);
  } catch (err) {
    next(err);
  }
});

weatherRouter.get('/forecast', (_req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const rows = db.select().from(weatherCache)
      .where(gte(weatherCache.forecastDate, today!))
      .orderBy(weatherCache.forecastDate)
      .limit(5)
      .all();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
