import { Router } from 'express';
import { db } from '../db/index.js';
import { cameraCaptures } from '../db/schema.js';
import { desc } from 'drizzle-orm';
import { fetchCamSnapshot } from '../services/claude.service.js';

export const cameraRouter = Router();

// ── Live snapshot proxy ───────────────────────────────────────────────────────
// Proxies Frigate's latest.jpg for the camera. The Angular frontend polls this
// every 2 s to produce a near-live view without needing RTSP or WebRTC.
cameraRouter.get('/snapshot', async (_req, res, next) => {
  try {
    const buf = await fetchCamSnapshot();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

// ── Latest stored capture (most recent AI-analyzed frame) ─────────────────────
cameraRouter.get('/latest', async (_req, res, next) => {
  try {
    const [row] = await db.select().from(cameraCaptures)
      .orderBy(desc(cameraCaptures.createdAt))
      .limit(1);
    res.json(row ?? null);
  } catch (err) {
    next(err);
  }
});
