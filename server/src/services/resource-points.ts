import type { Db } from '../db/types.js';

export interface ResourceMultiplierInput {
  modelId: string;
  inputMultiplier: number;
  cachedInputMultiplier?: number;
  outputMultiplier: number;
  enabled?: boolean;
}

const toMicros = (value: number) => Math.round(value * 1_000_000);

export function getResourcePointsPolicy(db: Db) {
  const policy = db.prepare(`SELECT official_quota_floor_percent officialQuotaFloorPercent,
    default_input_multiplier_micros / 1000000.0 defaultInputMultiplier,
    default_cached_input_multiplier_micros / 1000000.0 defaultCachedInputMultiplier,
    default_output_multiplier_micros / 1000000.0 defaultOutputMultiplier,
    updated_at updatedAt FROM resource_quota_policy WHERE id = 1`).get();
  const models = db.prepare(`SELECT discovered.modelId,
    COALESCE(rule.input_multiplier_micros, policy.default_input_multiplier_micros) / 1000000.0 inputMultiplier,
    COALESCE(rule.cached_input_multiplier_micros, policy.default_cached_input_multiplier_micros) / 1000000.0 cachedInputMultiplier,
    COALESCE(rule.output_multiplier_micros, policy.default_output_multiplier_micros) / 1000000.0 outputMultiplier,
    COALESCE(rule.enabled, 1) enabled, rule.model_id IS NOT NULL customized
    FROM (
      SELECT model_id modelId FROM resource_model_multipliers
      UNION SELECT DISTINCT model_id modelId FROM codex_oauth_account_models
      UNION SELECT DISTINCT model_id modelId FROM requests WHERE platform = 'openai-codex'
    ) discovered
    CROSS JOIN resource_quota_policy policy
    LEFT JOIN resource_model_multipliers rule ON rule.model_id = discovered.modelId
    WHERE policy.id = 1 ORDER BY discovered.modelId`).all();
  return { policy, models };
}

export function updateResourcePointsPolicy(db: Db, input: {
  officialQuotaFloorPercent: number;
  defaultInputMultiplier: number;
  defaultCachedInputMultiplier?: number;
  defaultOutputMultiplier: number;
  models?: ResourceMultiplierInput[];
}) {
  const floor = Number(input.officialQuotaFloorPercent);
  const defaultInput = toMicros(Number(input.defaultInputMultiplier));
  const defaultCachedInput = toMicros(Number(input.defaultCachedInputMultiplier ?? 0.25));
  const defaultOutput = toMicros(Number(input.defaultOutputMultiplier));
  if (!Number.isFinite(floor) || floor < 0 || floor > 100) throw new Error('Official quota protection line must be between 0 and 100');
  if (!Number.isSafeInteger(defaultInput) || defaultInput <= 0
    || !Number.isSafeInteger(defaultCachedInput) || defaultCachedInput <= 0
    || !Number.isSafeInteger(defaultOutput) || defaultOutput <= 0) {
    throw new Error('Default model multipliers must be greater than zero');
  }
  return db.transaction(() => {
    db.prepare(`UPDATE resource_quota_policy SET official_quota_floor_percent = ?,
      default_input_multiplier_micros = ?, default_cached_input_multiplier_micros = ?,
      default_output_multiplier_micros = ?, updated_at = datetime('now') WHERE id = 1`)
      .run(floor, defaultInput, defaultCachedInput, defaultOutput);
    for (const model of input.models ?? []) {
      const modelId = String(model.modelId ?? '').trim();
      const modelInput = toMicros(Number(model.inputMultiplier));
      const modelCachedInput = toMicros(Number(model.cachedInputMultiplier ?? input.defaultCachedInputMultiplier ?? 0.25));
      const modelOutput = toMicros(Number(model.outputMultiplier));
      if (!modelId || !Number.isSafeInteger(modelInput) || modelInput <= 0
        || !Number.isSafeInteger(modelCachedInput) || modelCachedInput <= 0
        || !Number.isSafeInteger(modelOutput) || modelOutput <= 0) throw new Error('Every model multiplier must be greater than zero');
      db.prepare(`INSERT INTO resource_model_multipliers
        (model_id, input_multiplier_micros, cached_input_multiplier_micros, output_multiplier_micros, enabled)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(model_id) DO UPDATE SET input_multiplier_micros = excluded.input_multiplier_micros,
          cached_input_multiplier_micros = excluded.cached_input_multiplier_micros,
          output_multiplier_micros = excluded.output_multiplier_micros, enabled = excluded.enabled,
          updated_at = datetime('now')`).run(modelId, modelInput, modelCachedInput, modelOutput, model.enabled === false ? 0 : 1);
    }
    return getResourcePointsPolicy(db);
  })();
}
