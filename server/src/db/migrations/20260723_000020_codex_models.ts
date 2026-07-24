import type { Db } from '../types.js';

export function up(db: Db): void {
  db.prepare(`
    INSERT OR IGNORE INTO models (
      platform,
      model_id,
      display_name,
      intelligence_rank,
      speed_rank,
      size_label,
      monthly_token_budget,
      enabled,
      supports_vision,
      supports_tools
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'openai-codex',
    'codex',
    'OpenAI Codex',
    1,
    1,
    '',
    '',
    1,
    0,
    0,
  );

  db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
    SELECT id, (SELECT COALESCE(MAX(priority), 0) + 1 FROM fallback_config), 1
      FROM models
     WHERE platform = 'openai-codex' AND model_id = 'codex'
  `).run();
}

export function down(_db: Db): void {
  throw new Error('irreversible migration: Codex model lifecycle is completed by later migrations');
}
