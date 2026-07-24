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
}

export function down(db: Db): void {
  db.prepare(`
    DELETE FROM models
    WHERE platform = ?
      AND model_id = ?
  `).run(
    'openai-codex',
    'codex',
  );
}