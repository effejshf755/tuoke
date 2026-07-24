import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_oauth_account_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES codex_oauth_accounts(id) ON DELETE CASCADE,
      UNIQUE (account_id, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_codex_oauth_account_models_account_enabled
      ON codex_oauth_account_models (account_id, enabled);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS codex_oauth_account_models;');
}
