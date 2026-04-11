import { Router } from 'express';
import { db } from '../db/index.js';
import { sensorReadings, settings, doorEvents, cameraCaptures } from '../db/schema.js';
import { desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import multer from 'multer';
import sharp from 'sharp';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import { analyzeCapture } from '../services/claude.service.js';
import type { SensorReadingRequest, DoorCommandRequest } from './types.js';

export const sensorRouter = Router();

// ── Sensor reading from ESP32 ─────────────────────────────────────────────────
sensorRouter.post('/sensor', (req, res, next) => {
  try {
    const body = req.body as SensorReadingRequest;
    db.insert(sensorReadings).values({
      distanceCm: body.distanceCm,
      irTriggered: body.irTriggered ?? false,
      chickensInside: body.chickensInside,
      totalChickens: body.totalChickens,
      doorState: body.doorState,
    }).run();

    wsBroadcaster.broadcast('sensor:reading', {
      distanceCm: body.distanceCm,
      irTriggered: body.irTriggered,
      chickensInside: body.chickensInside,
      doorState: body.doorState,
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

sensorRouter.get('/latest', (_req, res, next) => {
  try {
    const row = db.select().from(sensorReadings)
      .orderBy(desc(sensorReadings.createdAt))
      .limit(1)
      .get();
    res.json(row ?? null);
  } catch (err) {
    next(err);
  }
});

// ── Door event from ESP32 ─────────────────────────────────────────────────────
sensorRouter.post('/door-event', (req, res, next) => {
  try {
    const body = req.body as { fromState: string; toState: string; chickensInside?: number };
    db.insert(doorEvents).values({
      fromState: body.fromState,
      toState: body.toState,
      trigger: 'esp32',
      isManual: false,
      chickensInside: body.chickensInside,
    }).run();

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

// ── ESP32 command poll ────────────────────────────────────────────────────────
// Returns the pending command and atomically resets it to NONE.
sensorRouter.get('/command', (_req, res, next) => {
  try {
    const row = db.select({ pendingCommand: settings.pendingCommand })
      .from(settings)
      .where(eq(settings.id, 1))
      .get();

    const action = row?.pendingCommand ?? 'NONE';

    if (action !== 'NONE') {
      db.update(settings)
        .set({ pendingCommand: 'NONE' })
        .where(eq(settings.id, 1))
        .run();
    }

    res.json({ action, delay: 0 });
  } catch (err) {
    next(err);
  }
});

// ── Camera capture from ESP32 ─────────────────────────────────────────────────
const capturesDir = process.env['CAPTURES_DIR'] ?? join(process.cwd(), 'data', 'captures');
mkdirSync(capturesDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4 MB
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg');
  },
});

sensorRouter.post('/capture', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'BadRequest', message: 'No image field in request', statusCode: 400 });
      return;
    }

    const timestamp = Date.now();
    const fileName = `${timestamp}.jpg`;
    const filePath = join(capturesDir, fileName);

    // Resize to max 800px wide before saving
    const metadata = await sharp(req.file.buffer)
      .resize({ width: 800, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(filePath);

    // Get current door state for snapshot
    const latestDoor = db.select({ toState: doorEvents.toState })
      .from(doorEvents)
      .orderBy(desc(doorEvents.createdAt))
      .limit(1)
      .get();

    const latestSensor = db.select()
      .from(sensorReadings)
      .orderBy(desc(sensorReadings.createdAt))
      .limit(1)
      .get();

    const captureRow = db.insert(cameraCaptures).values({
      filePath: fileName,
      fileSizeBytes: metadata.size,
      widthPx: metadata.width,
      heightPx: metadata.height,
      doorStateAtCapture: latestDoor?.toState ?? 'UNKNOWN',
      chickensInsideAtCapture: latestSensor?.chickensInside,
    }).returning().get();

    wsBroadcaster.broadcast('camera:new_capture', {
      id: captureRow.id,
      filePath: captureRow.filePath,
      doorState: captureRow.doorStateAtCapture,
    });

    // Trigger async vision analysis — don't block the ESP32 response
    analyzeCapture(captureRow.id, filePath).catch((err: Error) =>
      console.error('[Vision] Analysis failed for capture', captureRow.id, err.message)
    );

    res.status(201).json({ id: captureRow.id, ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Camera listing (for Angular frontend) ────────────────────────────────────
sensorRouter.get('/latest-capture', (_req, res, next) => {
  try {
    const row = db.select().from(cameraCaptures)
      .orderBy(desc(cameraCaptures.createdAt))
      .limit(1)
      .get();
    res.json(row ?? null);
  } catch (err) {
    next(err);
  }
});
