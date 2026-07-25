import type { Db } from '../types.js';

export function up(db: Db): void {
  const addColumn = (name: string, definition: string) => {
    const columns = db.prepare('PRAGMA table_info(resource_subpools)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE resource_subpools ADD COLUMN ${name} ${definition}`);
    }
  };
  addColumn('quota_phase', 'INTEGER NOT NULL DEFAULT 5 CHECK (quota_phase BETWEEN 1 AND 5)');
  addColumn('phase_release_percent', 'REAL NOT NULL DEFAULT 20 CHECK (phase_release_percent > 0 AND phase_release_percent <= 100)');
  addColumn('phase_started_official_percent', 'REAL');
  addColumn('phase_started_used_units', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('phase_released_units', 'INTEGER');
  addColumn('phase_multiplier_factor_micros', 'INTEGER NOT NULL DEFAULT 1000000 CHECK (phase_multiplier_factor_micros > 0)');
  addColumn('phase_started_at', 'TEXT');
}

export function down(_db: Db): void {
  throw new Error('irreversible migration: SQLite requires a table rebuild to remove quota phase columns');
}
