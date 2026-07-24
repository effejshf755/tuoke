import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(codex_oauth_accounts)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'deleted_at')) {
    db.exec('ALTER TABLE codex_oauth_accounts ADD COLUMN deleted_at TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_codex_oauth_accounts_deleted ON codex_oauth_accounts(deleted_at)');
}

export function down(db: Db): void {
  db.exec('DROP INDEX IF EXISTS idx_codex_oauth_accounts_deleted');
  db.exec('ALTER TABLE codex_oauth_accounts DROP COLUMN deleted_at');
}
