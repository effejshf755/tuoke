import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec("ALTER TABLE users ADD COLUMN monthly_token_limit INTEGER NOT NULL DEFAULT 1000000");
}

export function down(_db: Db): void {
  // SQLite cannot safely drop a column without rebuilding the users table.
}
