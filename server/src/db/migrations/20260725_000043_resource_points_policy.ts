import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_model_multipliers (
      model_id TEXT PRIMARY KEY,
      input_multiplier_micros INTEGER NOT NULL DEFAULT 1000000 CHECK (input_multiplier_micros > 0),
      output_multiplier_micros INTEGER NOT NULL DEFAULT 1000000 CHECK (output_multiplier_micros > 0),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS resource_quota_policy (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      official_quota_floor_percent REAL NOT NULL DEFAULT 2
        CHECK (official_quota_floor_percent >= 0 AND official_quota_floor_percent <= 100),
      default_input_multiplier_micros INTEGER NOT NULL DEFAULT 1000000
        CHECK (default_input_multiplier_micros > 0),
      default_output_multiplier_micros INTEGER NOT NULL DEFAULT 1000000
        CHECK (default_output_multiplier_micros > 0),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO resource_quota_policy (id) VALUES (1);
  `);

  const columns = db.prepare(`PRAGMA table_info(resource_quota_reservations)`).all() as Array<{ name: string }>;
  const add = (name: string, sql: string) => {
    if (!columns.some((column) => column.name === name)) db.exec(sql);
  };
  add('model_id', `ALTER TABLE resource_quota_reservations ADD COLUMN model_id TEXT`);
  add('input_tokens', `ALTER TABLE resource_quota_reservations ADD COLUMN input_tokens INTEGER`);
  add('output_tokens', `ALTER TABLE resource_quota_reservations ADD COLUMN output_tokens INTEGER`);
  add('input_multiplier_micros', `ALTER TABLE resource_quota_reservations ADD COLUMN input_multiplier_micros INTEGER NOT NULL DEFAULT 1000000`);
  add('output_multiplier_micros', `ALTER TABLE resource_quota_reservations ADD COLUMN output_multiplier_micros INTEGER NOT NULL DEFAULT 1000000`);
  add('official_quota_percent_before', `ALTER TABLE resource_quota_reservations ADD COLUMN official_quota_percent_before REAL`);
  add('official_quota_percent_after', `ALTER TABLE resource_quota_reservations ADD COLUMN official_quota_percent_after REAL`);
}

export function down(db: Db): void {
  db.exec(`DROP TABLE IF EXISTS resource_model_multipliers; DROP TABLE IF EXISTS resource_quota_policy;`);
}
