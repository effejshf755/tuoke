import type { Db } from '../db/types.js';

import {
  calculateBillingAmountMicro,
} from './billing.js';
import {
  getModelGroups,
  isUnifyEnabled,
  resolveRequestedIdToMembers,
} from './model-groups.js';

export interface BillingReservationEstimate {
  status:
    | 'ok'
    | 'no_billing_rule';

  requestedModel: string | null;

  estimatedInputTokens: number;
  maximumOutputTokens: number;

  reserveMicro: number;

  matchedRuleCount: number;
}

interface ReservationRuleRow {
  platform: string;
  modelId: string;

  inputPriceMicroPerMillion: number;
  outputPriceMicroPerMillion: number;

  multiplierMilli: number;
}

/*
 * Output token fallback when the client does not
 * explicitly provide max_tokens.
 *
 * This can later be moved to admin settings.
 */
const DEFAULT_MAX_OUTPUT_TOKENS =
  Math.max(
    1,
    Number(
      process.env
        .BILLING_DEFAULT_MAX_OUTPUT_TOKENS ??
        8192,
    ) || 8192,
  );

const MAX_OUTPUT_TOKEN_SANITY_LIMIT =
  262_144;

/**
 * Conservative request-body token estimate.
 *
 * We intentionally do NOT use chars / 4 here because
 * Chinese and other Unicode text can consume far more
 * tokens than English text.
 *
 * Over-reservation is safe because unused reserved
 * balance will be released after settlement.
 */
function estimateInputTokens(
  body: unknown,
): number {
  let serialized = '';

  try {
    serialized =
      JSON.stringify(
        body ?? {},
      );
  } catch {
    serialized = '';
  }

  return Math.max(
    1,
    Math.ceil(
      serialized.length *
        1.25,
    ),
  );
}

function readPositiveInteger(
  value: unknown,
): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;

  if (
    !Number.isFinite(
      parsed,
    ) ||
    parsed <= 0
  ) {
    return null;
  }

  return Math.max(
    1,
    Math.min(
      MAX_OUTPUT_TOKEN_SANITY_LIMIT,
      Math.trunc(parsed),
    ),
  );
}

function getMaximumOutputTokens(
  body: any,
): number {
  return (
    readPositiveInteger(
      body?.max_completion_tokens,
    ) ??
    readPositiveInteger(
      body?.max_tokens,
    ) ??
    DEFAULT_MAX_OUTPUT_TOKENS
  );
}

function getRequestedModel(
  body: any,
): string | null {
  const value =
    body?.model;

  if (
    typeof value !==
    'string'
  ) {
    return null;
  }

  const trimmed =
    value.trim();

  return trimmed ||
    null;
}

function getCandidateRules(
  db: Db,
  requestedModel: string | null,
): ReservationRuleRow[] {
  /*
   * auto / missing model:
   *
   * The router may select any enabled billable model,
   * so reserve against the most expensive possible rule.
   */
  if (
    !requestedModel ||
    requestedModel === 'auto'
  ) {
    return db.prepare(`
      SELECT
        platform,
        model_id AS modelId,

        input_price_micro_per_million
          AS inputPriceMicroPerMillion,

        output_price_micro_per_million
          AS outputPriceMicroPerMillion,

        multiplier_milli
          AS multiplierMilli

      FROM model_billing_rules

      WHERE billing_enabled = 1
    `).all() as
      ReservationRuleRow[];
  }

  /*
   * A specific model can exist under more than one
   * provider/platform.
   *
   * Take every matching rule and later reserve using
   * the most expensive possible route.
   */
  const requestedModelIds = new Set([requestedModel]);

  // /v1/models advertises a canonical group id when model unification is on,
  // while billing rules are stored against the original provider model ids.
  // Resolve both canonical and legacy/raw requests before checking billing.
  if (isUnifyEnabled()) {
    const memberDbIds = resolveRequestedIdToMembers(
      requestedModel,
      getModelGroups(),
    );
    if (memberDbIds?.length) {
      const placeholders = memberDbIds.map(() => '?').join(', ');
      const members = db.prepare(`
        SELECT model_id AS modelId
        FROM models
        WHERE id IN (${placeholders})
      `).all(...memberDbIds) as Array<{ modelId: string }>;
      for (const member of members) requestedModelIds.add(member.modelId);
    }
  }

  const modelPlaceholders = [...requestedModelIds].map(() => '?').join(', ');
  return db.prepare(`
    SELECT
      platform,
      model_id AS modelId,

      input_price_micro_per_million
        AS inputPriceMicroPerMillion,

      output_price_micro_per_million
        AS outputPriceMicroPerMillion,

      multiplier_milli
        AS multiplierMilli

    FROM model_billing_rules

    WHERE billing_enabled = 1
      AND model_id IN (${modelPlaceholders})
  `).all(
    ...requestedModelIds,
  ) as
    ReservationRuleRow[];
}

/**
 * Calculates a conservative prepaid authorization
 * amount before an upstream model is called.
 *
 * For auto-routing, the highest possible configured
 * model cost is used.
 */
export function estimateBillingReservation(
  db: Db,
  body: unknown,
): BillingReservationEstimate {
  const requestedModel =
    getRequestedModel(
      body,
    );

  const estimatedInputTokens =
    estimateInputTokens(
      body,
    );

  const maximumOutputTokens =
    getMaximumOutputTokens(
      body as any,
    );

  const rules =
    getCandidateRules(
      db,
      requestedModel,
    );

  if (
    rules.length === 0
  ) {
    return {
      status:
        'no_billing_rule',

      requestedModel,

      estimatedInputTokens,
      maximumOutputTokens,

      reserveMicro: 0,

      matchedRuleCount: 0,
    };
  }

  let highestCostMicro = 0;

  for (
    const rule of rules
  ) {
    const amountMicro =
      calculateBillingAmountMicro(
        estimatedInputTokens,
        maximumOutputTokens,

        rule.inputPriceMicroPerMillion,
        rule.outputPriceMicroPerMillion,

        rule.multiplierMilli,
      );

    highestCostMicro =
      Math.max(
        highestCostMicro,
        amountMicro,
      );
  }

  /*
   * Minimum reservation is 1 micro.
   *
   * Explicitly free models can later bypass the
   * reservation during middleware processing.
   */
  return {
    status: 'ok',

    requestedModel,

    estimatedInputTokens,
    maximumOutputTokens,

    reserveMicro:
      Math.max(
        1,
        highestCostMicro,
      ),

    matchedRuleCount:
      rules.length,
  };
}
