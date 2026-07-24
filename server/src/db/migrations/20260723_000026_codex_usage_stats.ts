import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_usage_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      api_key_id INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES codex_oauth_accounts(id) ON DELETE CASCADE,
      UNIQUE (account_id, model_id, api_key_id)
    );
    CREATE INDEX IF NOT EXISTS idx_codex_usage_stats_account ON codex_usage_stats (account_id);
    CREATE INDEX IF NOT EXISTS idx_codex_usage_stats_model ON codex_usage_stats (model_id);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS codex_usage_stats;');
}
