import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'))");
}

export function down(_db: Db): void {}
