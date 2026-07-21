import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'consumer_user_id')) db.exec('ALTER TABLE requests ADD COLUMN consumer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  if (!columns.some((column) => column.name === 'consumer_api_key_id')) db.exec('ALTER TABLE requests ADD COLUMN consumer_api_key_id INTEGER REFERENCES consumer_api_keys(id) ON DELETE SET NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_consumer_user ON requests(consumer_user_id)');
}

export function down(db: Db): void {
  db.exec('DROP INDEX IF EXISTS idx_requests_consumer_user');
}
