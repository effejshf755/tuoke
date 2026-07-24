import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(consumer_api_keys)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'key_type')) {
    db.exec(`
      ALTER TABLE consumer_api_keys
      ADD COLUMN key_type TEXT NOT NULL DEFAULT 'universal'
      CHECK (key_type IN ('universal', 'codex_pool'))
    `);
  }
}

export function down(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(consumer_api_keys)').all() as { name: string }[];
  if (columns.some((column) => column.name === 'key_type')) {
    db.exec('ALTER TABLE consumer_api_keys DROP COLUMN key_type');
  }
}
