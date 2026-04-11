import { db } from '../db/index.js';
import { statusMessages, sensorReadings, cameraCaptures } from '../db/schema.js';
import { and, eq, lt, sql } from 'drizzle-orm';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

const capturesDir = process.env['CAPTURES_DIR'] ?? join(process.cwd(), 'data', 'captures');

export function messageCleanupJob(): void {
  console.log('[Job:message-cleanup] Running');

  // Delete non-pinned status messages older than 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const deletedMessages = db.delete(statusMessages)
    .where(and(
      eq(statusMessages.isPinned, false),
      lt(statusMessages.createdAt, thirtyDaysAgo),
    ))
    .returning({ id: statusMessages.id })
    .all();

  // Delete sensor readings older than 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const deletedSensors = db.delete(sensorReadings)
    .where(lt(sensorReadings.createdAt, sevenDaysAgo))
    .returning({ id: sensorReadings.id })
    .all();

  // Delete non-anomaly captures older than 48 hours
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const staleCaptures = db.delete(cameraCaptures)
    .where(and(
      eq(cameraCaptures.isAnomaly, false),
      lt(cameraCaptures.createdAt, fortyEightHoursAgo),
    ))
    .returning({ id: cameraCaptures.id, filePath: cameraCaptures.filePath })
    .all();

  for (const capture of staleCaptures) {
    try {
      unlinkSync(join(capturesDir, capture.filePath));
    } catch {
      // File may already be gone — not an error
    }
  }

  // Delete anomaly captures older than 30 days
  const oldAnomalyCaptures = db.delete(cameraCaptures)
    .where(and(
      eq(cameraCaptures.isAnomaly, true),
      lt(cameraCaptures.createdAt, thirtyDaysAgo),
    ))
    .returning({ id: cameraCaptures.id, filePath: cameraCaptures.filePath })
    .all();

  for (const capture of oldAnomalyCaptures) {
    try {
      unlinkSync(join(capturesDir, capture.filePath));
    } catch {
      // ignore
    }
  }

  // Unpin old non-critical alerts (older than today)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  db.update(statusMessages)
    .set({ isPinned: false })
    .where(and(
      eq(statusMessages.isPinned, true),
      eq(statusMessages.isError, false),
      lt(statusMessages.createdAt, todayStart.toISOString()),
    ))
    .run();

  console.log(
    `[Job:message-cleanup] Deleted: ${deletedMessages.length} messages, ${deletedSensors.length} sensor rows, ` +
    `${staleCaptures.length + oldAnomalyCaptures.length} captures`
  );
}
