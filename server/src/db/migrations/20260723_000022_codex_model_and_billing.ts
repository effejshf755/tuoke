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
    INSERT OR IGNORE INTO model_billing_rules (
      platform,
      model_id,
      input_price_micro_per_million,
      output_price_micro_per_million,
      multiplier_milli,
      billing_enabled
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'openai-codex',
    'codex',
    0,
    0,
    1000,
    1,
  );

  db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
    SELECT id, (SELECT COALESCE(MAX(priority), 0) + 1 FROM fallback_config), 1
      FROM models
     WHERE platform = 'openai-codex' AND model_id = 'codex'
  `).run();
}

export function down(db: Db): void {
  db.prepare(`
    DELETE FROM model_billing_rules
    WHERE platform = ? AND model_id = ?
  `).run('openai-codex', 'codex');

  db.prepare(`DELETE FROM fallback_config WHERE model_db_id IN (
    SELECT id FROM models WHERE platform = ? AND model_id = ?
  )`).run('openai-codex', 'codex');

  db.prepare(`
    DELETE FROM models
    WHERE platform = ? AND model_id = ?
  `).run('openai-codex', 'codex');
}
