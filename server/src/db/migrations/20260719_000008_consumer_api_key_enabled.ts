import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(consumer_api_keys)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'enabled')) db.exec('ALTER TABLE consumer_api_keys ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))');
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_consumer_api_key ON requests(consumer_api_key_id)');
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_requests_consumer_api_key;
  `);
}
