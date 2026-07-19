import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consumer_api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_consumer_api_keys_user ON consumer_api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_consumer_api_keys_prefix ON consumer_api_keys(key_prefix);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS consumer_api_keys');
}
