import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'upstream_model_id')) {
    db.exec('ALTER TABLE models ADD COLUMN upstream_model_id TEXT');
  }

  db.prepare(`
    UPDATE models
    SET upstream_model_id = 'gpt-5.6-luna'
    WHERE platform = 'openai-codex' AND model_id = 'codex'
  `).run();
}

export function down(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  if (columns.some((column) => column.name === 'upstream_model_id')) {
    db.exec('ALTER TABLE models DROP COLUMN upstream_model_id');
  }
}
