import type { Db } from '../db/types.js';
import { calculateBillingAmountMicro } from './billing.js';
import type { BillingReservationEstimate } from './billing-reservation.js';

interface CodexBillingRuleRow {
  inputPriceMicroPerMillion: number;
  outputPriceMicroPerMillion: number;
  multiplierMilli: number;
}

const DEFAULT_MAX_OUTPUT_TOKENS = Math.max(
  1,
  Number(process.env.BILLING_DEFAULT_MAX_OUTPUT_TOKENS ?? 8192) || 8192,
);
const MAX_OUTPUT_TOKEN_SANITY_LIMIT = 262_144;

function estimateInputTokens(body: unknown): number {
  try {
    return Math.max(1, Math.ceil(JSON.stringify(body ?? {}).length * 1.25));
  } catch {
    return 1;
  }
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.min(MAX_OUTPUT_TOKEN_SANITY_LIMIT, Math.trunc(parsed)));
}

/**
 * Reserve against the most expensive real model currently available in the
 * Codex OAuth pool. The public alias remains `codex`, while settlement uses
 * the actual model selected by the router.
 */
export function estimateCodexBillingReservation(
  db: Db,
  body: unknown,
): BillingReservationEstimate {
  const requestBody = body as Record<string, unknown> | null;
  const requestedModel = typeof requestBody?.model === 'string'
    ? requestBody.model.trim() || null
    : null;
  const estimatedInputTokens = estimateInputTokens(body);
  const maximumOutputTokens = readPositiveInteger(requestBody?.max_completion_tokens)
    ?? readPositiveInteger(requestBody?.max_tokens)
    ?? DEFAULT_MAX_OUTPUT_TOKENS;

  const rules = db.prepare(`
    SELECT DISTINCT
      b.input_price_micro_per_million AS inputPriceMicroPerMillion,
      b.output_price_micro_per_million AS outputPriceMicroPerMillion,
      b.multiplier_milli AS multiplierMilli
    FROM codex_oauth_accounts a
    JOIN codex_oauth_account_models am
      ON am.account_id = a.id
     AND am.enabled = 1
    JOIN model_billing_rules b
      ON b.platform = 'openai-codex'
     AND b.model_id = am.model_id
     AND b.billing_enabled = 1
    WHERE a.enabled = 1
      AND a.status IN ('healthy', 'unknown')
      AND (a.cooldown_until IS NULL OR a.cooldown_until <= datetime('now'))
  `).all() as CodexBillingRuleRow[];

  if (rules.length === 0) {
    return {
      status: 'no_billing_rule',
      requestedModel,
      estimatedInputTokens,
      maximumOutputTokens,
      reserveMicro: 0,
      matchedRuleCount: 0,
    };
  }

  let highestCostMicro = 0;
  for (const rule of rules) {
    highestCostMicro = Math.max(
      highestCostMicro,
      calculateBillingAmountMicro(
        estimatedInputTokens,
        maximumOutputTokens,
        rule.inputPriceMicroPerMillion,
        rule.outputPriceMicroPerMillion,
        rule.multiplierMilli,
      ),
    );
  }

  return {
    status: 'ok',
    requestedModel,
    estimatedInputTokens,
    maximumOutputTokens,
    // A deliberately free Codex rule must not require the user to hold a
    // positive wallet balance. The middleware skips reservation when this is
    // zero, while paid rules still reserve their calculated maximum cost.
    reserveMicro: Math.max(0, highestCostMicro),
    matchedRuleCount: rules.length,
  };
}
