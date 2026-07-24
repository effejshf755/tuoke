import type { Db } from '../types.js';

export function up(db: Db): void {
  const keyColumns = db.prepare('PRAGMA table_info(consumer_api_keys)').all() as Array<{ name: string }>;
  if (!keyColumns.some(column => column.name === 'key_scope')) {
    db.exec(`ALTER TABLE consumer_api_keys ADD COLUMN key_scope TEXT NOT NULL DEFAULT 'universal'
      CHECK (key_scope IN ('universal', 'codex_pool', 'resource_subpool'))`);
    db.exec(`UPDATE consumer_api_keys SET key_scope = key_type`);
  }

  const accountColumns = db.prepare('PRAGMA table_info(codex_oauth_accounts)').all() as Array<{ name: string }>;
  if (!accountColumns.some(column => column.name === 'resource_scope')) {
    db.exec(`ALTER TABLE codex_oauth_accounts ADD COLUMN resource_scope TEXT NOT NULL DEFAULT 'codex_pool'
      CHECK (resource_scope IN ('codex_pool', 'resource_subpool'))`);
  }

  // Existing live relationships are authoritative: preserve them as isolated
  // resource entitlements instead of leaving them in the shared Codex pool.
  db.exec(`
    UPDATE consumer_api_keys
       SET key_scope = 'resource_subpool'
     WHERE id IN (
       SELECT consumer_api_key_id FROM resource_subpool_members
        WHERE consumer_api_key_id IS NOT NULL
     );

    UPDATE codex_oauth_accounts
       SET resource_scope = 'resource_subpool'
     WHERE id IN (
       SELECT codex_account_id FROM resource_subpool_bindings
        WHERE status IN ('active', 'migrating')
       UNION
       SELECT pending_codex_account_id FROM resource_subpools
        WHERE pending_codex_account_id IS NOT NULL
     );

    CREATE INDEX IF NOT EXISTS idx_consumer_api_keys_scope ON consumer_api_keys(key_scope);
    CREATE INDEX IF NOT EXISTS idx_codex_oauth_accounts_scope ON codex_oauth_accounts(resource_scope);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_consumer_api_keys_scope;
    DROP INDEX IF EXISTS idx_codex_oauth_accounts_scope;
  `);
  db.exec(`ALTER TABLE consumer_api_keys DROP COLUMN key_scope`);
  db.exec(`ALTER TABLE codex_oauth_accounts DROP COLUMN resource_scope`);
}
