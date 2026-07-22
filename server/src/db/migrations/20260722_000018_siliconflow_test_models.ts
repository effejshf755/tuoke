import type { Db } from '../types.js';

const MODELS = [
  ['deepseek-ai/DeepSeek-V3', 'DeepSeek V3 (SiliconFlow)', 163840],
  ['deepseek-ai/DeepSeek-R1', 'DeepSeek R1 (SiliconFlow)', 163840],
  ['Qwen/Qwen2.5-72B-Instruct', 'Qwen 2.5 72B Instruct (SiliconFlow)', 32768],
] as const;

export function up(db: Db): void {
  const insertModel = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, monthly_token_budget, context_window, enabled
    ) VALUES ('siliconflow', ?, ?, 20, 20, 'Large', 'provider-defined', ?, 1)
  `);
  const insertFallback = db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
    SELECT id, (SELECT COALESCE(MAX(priority), 0) + 1 FROM fallback_config), 1
      FROM models
     WHERE platform = 'siliconflow' AND model_id = ?
  `);
  const insertBilling = db.prepare(`
    INSERT OR IGNORE INTO model_billing_rules (
      platform, model_id, input_price_micro_per_million,
      output_price_micro_per_million, multiplier_milli, billing_enabled
    ) VALUES ('siliconflow', ?, 0, 0, 1000, 0)
  `);
  db.transaction(() => {
    for (const [modelId, displayName, contextWindow] of MODELS) {
      insertModel.run(modelId, displayName, contextWindow);
      insertFallback.run(modelId);
      insertBilling.run(modelId);
    }
  })();
}

export function down(db: Db): void {
  for (const [modelId] of MODELS) {
    db.prepare(`DELETE FROM model_billing_rules WHERE platform = 'siliconflow' AND model_id = ?`).run(modelId);
    db.prepare(`DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'siliconflow' AND model_id = ?)`).run(modelId);
    db.prepare(`DELETE FROM models WHERE platform = 'siliconflow' AND model_id = ?`).run(modelId);
  }
}
