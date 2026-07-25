import type { Db } from '../types.js';

export function up(db: Db): void {
  const addColumn = (name: string, definition: string) => {
    const columns = db.prepare('PRAGMA table_info(resource_subpools)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE resource_subpools ADD COLUMN ${name} ${definition}`);
    }
  };

  // Existing pools remain fully released. Newly activated pools explicitly enter stage one.
  addColumn('quota_stage', "INTEGER NOT NULL DEFAULT 2 CHECK (quota_stage IN (1, 2))");
  addColumn('stage_one_release_percent', 'REAL NOT NULL DEFAULT 50 CHECK (stage_one_release_percent > 0 AND stage_one_release_percent < 100)');
  addColumn('stage_one_floor_percent', 'REAL NOT NULL DEFAULT 50 CHECK (stage_one_floor_percent >= 0 AND stage_one_floor_percent <= 100)');
  addColumn('stage_started_official_percent', 'REAL');
  addColumn('stage_one_released_units', 'INTEGER');
  addColumn('stage_one_used_units', 'INTEGER');
  addColumn('stage_one_completed_official_percent', 'REAL');
  addColumn('stage_one_completed_at', 'TEXT');
  addColumn('stage_two_released_at', 'TEXT');
  addColumn('stage_two_multiplier_factor_micros', 'INTEGER NOT NULL DEFAULT 1000000 CHECK (stage_two_multiplier_factor_micros > 0)');
}

export function down(_db: Db): void {
  throw new Error('irreversible migration: SQLite requires a table rebuild to remove quota stage columns');
}
