import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
      content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
      kind TEXT NOT NULL DEFAULT 'info'
        CHECK (kind IN ('info', 'important', 'maintenance')),
      published_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      published_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS site_notification_reads (
      notification_id INTEGER NOT NULL REFERENCES site_notifications(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (notification_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_site_notifications_published
      ON site_notifications(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_site_notification_reads_user
      ON site_notification_reads(user_id, read_at DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_site_notification_reads_user;
    DROP INDEX IF EXISTS idx_site_notifications_published;
    DROP TABLE IF EXISTS site_notification_reads;
    DROP TABLE IF EXISTS site_notifications;
  `);
}
