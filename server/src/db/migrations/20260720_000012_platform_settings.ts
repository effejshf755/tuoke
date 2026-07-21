import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(consumer_api_keys)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'rate_limit_rpm')) db.exec(`ALTER TABLE consumer_api_keys ADD COLUMN rate_limit_rpm INTEGER CHECK (rate_limit_rpm IS NULL OR (rate_limit_rpm >= 0 AND rate_limit_rpm <= 100000))`);
  db.exec(`
    INSERT INTO settings(key,value) VALUES
      ('default_consumer_rpm','60'),('registration_enabled','1'),
      ('new_user_bonus_micro','0'),('minimum_recharge_micro','1000000'),
      ('maximum_recharge_micro','1000000000000'),('platform_notice',''),('maintenance_mode','0')
      ON CONFLICT(key) DO NOTHING;
  `);
}

export function down(db: Db): void {
  db.pragma('foreign_keys = OFF');
  db.exec(`CREATE TABLE consumer_api_keys_platform_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, key_prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, expires_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)));
    INSERT INTO consumer_api_keys (id, user_id, name, key_prefix, key_hash, status, created_at, last_used_at, expires_at, enabled)
      SELECT id, user_id, name, key_prefix, key_hash, status, created_at, last_used_at, expires_at, enabled
      FROM consumer_api_keys_platform_settings;
    DROP TABLE consumer_api_keys;
    ALTER TABLE consumer_api_keys_platform_settings RENAME TO consumer_api_keys;
    CREATE INDEX IF NOT EXISTS idx_consumer_api_keys_user ON consumer_api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_consumer_api_keys_prefix ON consumer_api_keys(key_prefix);`);
  db.pragma('foreign_keys = ON');
}
