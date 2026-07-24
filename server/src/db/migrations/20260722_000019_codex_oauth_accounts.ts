import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_oauth_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      account_id TEXT,
      access_token_encrypted TEXT NOT NULL,
      access_token_iv TEXT NOT NULL,
      access_token_auth_tag TEXT NOT NULL,
      refresh_token_encrypted TEXT NOT NULL,
      refresh_token_iv TEXT NOT NULL,
      refresh_token_auth_tag TEXT NOT NULL,
      token_expires_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_used_at TEXT,
      last_checked_at TEXT,
      last_error TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      cooldown_until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_codex_oauth_accounts_status
    ON codex_oauth_accounts(status);

    CREATE INDEX IF NOT EXISTS idx_codex_oauth_accounts_enabled
    ON codex_oauth_accounts(enabled);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS codex_oauth_accounts');
}