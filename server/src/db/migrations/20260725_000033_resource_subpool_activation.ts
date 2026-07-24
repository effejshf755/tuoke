import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    ALTER TABLE resource_subpools
      ADD COLUMN pending_codex_account_id INTEGER REFERENCES codex_oauth_accounts(id) ON DELETE RESTRICT;
    ALTER TABLE resource_subpools
      ADD COLUMN activated_by_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE resource_subpools ADD COLUMN activated_at TEXT;
    CREATE INDEX IF NOT EXISTS idx_resource_subpools_pending_account
      ON resource_subpools(pending_codex_account_id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_resource_subpools_pending_account;
    ALTER TABLE resource_subpools DROP COLUMN activated_at;
    ALTER TABLE resource_subpools DROP COLUMN activated_by_admin_id;
    ALTER TABLE resource_subpools DROP COLUMN pending_codex_account_id;
  `);
}
