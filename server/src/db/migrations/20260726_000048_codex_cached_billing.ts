import type { Db } from '../types.js';

export function up(db: Db): void {
  const addColumn = (table: string, name: string, definition: string) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };

  addColumn('model_billing_rules', 'cached_input_multiplier_milli', 'INTEGER NOT NULL DEFAULT 1000 CHECK (cached_input_multiplier_milli >= 0)');
  addColumn('requests', 'cached_input_tokens', 'INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0)');
  addColumn('wallet_transactions', 'cached_input_tokens', 'INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0)');
  addColumn('wallet_transactions', 'cached_input_multiplier_milli', 'INTEGER NOT NULL DEFAULT 1000 CHECK (cached_input_multiplier_milli >= 0)');
}

export function down(_db: Db): void {
  throw new Error('irreversible migration: SQLite requires table rebuilds to remove cached billing columns');
}
