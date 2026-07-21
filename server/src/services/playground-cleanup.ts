import { getDb } from '../db/index.js';
import type { Scheduler } from '../lib/scheduler.js';

const CLEANUP_INTERVAL_MS =
  24 * 60 * 60 * 1000;

const RETENTION_DAYS = 30;

function cleanupOldPlaygroundConversations(): void {
  const result = getDb()
    .prepare(`
      DELETE FROM playground_conversations
      WHERE updated_at < datetime(
        'now',
        '-' || ? || ' days'
      )
    `)
    .run(RETENTION_DAYS);

  if (result.changes > 0) {
    console.log(
      `[playground-cleanup] deleted ${result.changes} expired conversations`,
    );
  }
}

export function startPlaygroundCleanup(
  scheduler: Scheduler,
): void {
  cleanupOldPlaygroundConversations();

  scheduler.every(
    CLEANUP_INTERVAL_MS,
    cleanupOldPlaygroundConversations,
  );
}