import type { Db } from '../types.js';

const FREE_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'openai/gpt-oss-20b:free',
  'poolside/laguna-m.1:free',
];

export function up(db: Db): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO model_billing_rules (
      platform,
      model_id,
      input_price_micro_per_million,
      output_price_micro_per_million,
      multiplier_milli,
      billing_enabled
    )
    VALUES (
      'openrouter',
      ?,
      0,
      0,
      1000,
      1
    )
  `);

  for (const modelId of FREE_MODELS) {
    insert.run(modelId);
  }
}

export function down(db: Db): void {
  const remove = db.prepare(`
    DELETE FROM model_billing_rules
    WHERE platform = 'openrouter'
      AND model_id = ?
  `);

  for (const modelId of FREE_MODELS) {
    remove.run(modelId);
  }
}