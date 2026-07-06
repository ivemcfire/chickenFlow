import { db } from '../db/index.js';
import { statusMessages } from '../db/schema.js';
import { and, eq, lt } from 'drizzle-orm';

export async function messageCleanupJob(): Promise<void> {
  console.log('[Job:message-cleanup] Running');

  // Delete non-pinned status messages older than 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const deletedMessages = await db.delete(statusMessages)
    .where(and(
      eq(statusMessages.isPinned, false),
      lt(statusMessages.createdAt, thirtyDaysAgo),
    ))
    .returning({ id: statusMessages.id });

  // Unpin old non-critical alerts (older than today)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  await db.update(statusMessages)
    .set({ isPinned: false })
    .where(and(
      eq(statusMessages.isPinned, true),
      eq(statusMessages.isError, false),
      lt(statusMessages.createdAt, todayStart),
    ));

  console.log(`[Job:message-cleanup] Deleted: ${deletedMessages.length} messages`);
}
