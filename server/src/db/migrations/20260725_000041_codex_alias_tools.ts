import type { Db } from '../types.js';

export function up(db: Db): void {
  db.prepare(`
    UPDATE models
    SET supports_tools = 1
    WHERE platform = 'openai-codex' AND model_id = 'codex'
  `).run();
}

export function down(db: Db): void {
  db.prepare(`
    UPDATE models
    SET supports_tools = 0
    WHERE platform = 'openai-codex' AND model_id = 'codex'
  `).run();
}
