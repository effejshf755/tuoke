import type { Db } from '../types.js';

export function up(db: Db): void {
  const userColumns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (!userColumns.some((column) => column.name === 'free_model_bonus_until')) {
    db.exec('ALTER TABLE users ADD COLUMN free_model_bonus_until TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS free_model_daily_usage (
      user_id INTEGER NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,
      usage_date TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0
        CHECK (request_count >= 0),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, usage_date)
    );

    CREATE INDEX IF NOT EXISTS idx_free_model_daily_usage_date
      ON free_model_daily_usage(usage_date);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_free_model_daily_usage_date;
    DROP TABLE IF EXISTS free_model_daily_usage;
  `);
}
