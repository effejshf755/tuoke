import type { Db } from '../types.js';

export function up(db: Db): void {
  const addColumn = (table: string, name: string, definition: string) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };

  addColumn('resource_quota_policy', 'default_cached_input_multiplier_micros', 'INTEGER NOT NULL DEFAULT 250000');
  addColumn('resource_model_multipliers', 'cached_input_multiplier_micros', 'INTEGER NOT NULL DEFAULT 250000');
  addColumn('resource_quota_reservations', 'cached_input_tokens', 'INTEGER');
  addColumn('resource_quota_reservations', 'cached_input_multiplier_micros', 'INTEGER NOT NULL DEFAULT 250000');
  addColumn('codex_usage_records', 'cached_input_tokens', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('codex_usage_stats', 'cached_input_tokens', 'INTEGER NOT NULL DEFAULT 0');
}

export function down(_db: Db): void {
  throw new Error('irreversible migration: SQLite requires table rebuilds to remove cached points columns');
}
