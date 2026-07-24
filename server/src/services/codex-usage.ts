import type { Db } from '../db/types.js';
import { raiseResourceAlert } from './resource-alerts.js';
import { getDb } from '../db/index.js';
import {
  getClientContext,
  setCodexUsageRecordId,
  markResourceUsageObserved,
} from '../lib/client-context.js';

export interface CodexUsageResult {
  accountDbId: number;
  modelId: string;
  success: boolean;
  inputTokens?: number;
  outputTokens?: number;
  error?: string | null;
  authenticationFailure?: boolean;
  quotaExhausted?: boolean;
}

interface CodexUsageTokens {
  inputTokens: number;
  outputTokens: number;
}

function safeCount(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value!)
    : 0;
}

/**
 * Record the provider-side Codex attempt before the generic request logger
 * runs. The row id is stored in AsyncLocalStorage so the request, wallet
 * settlement and OAuth account can be linked without exposing OAuth tokens.
 */
export function recordCodexUsage(result: CodexUsageResult): number {
  const db = getDb();
  const context = getClientContext();
  const inputTokens = safeCount(result.inputTokens);
  const outputTokens = safeCount(result.outputTokens);
  const totalTokens = inputTokens + outputTokens;
  if (totalTokens > 0) markResourceUsageObserved();
  const aggregateApiKeyId = context.consumerApiKeyId ?? 0;
  const error = result.error?.slice(0, 2_000) || null;

  const recordId = db.transaction(() => {
    const account = db.prepare(`
      SELECT label
      FROM codex_oauth_accounts
      WHERE id = ?
    `).get(result.accountDbId) as { label: string } | undefined;

    const inserted = db.prepare(`
      INSERT INTO codex_usage_records (
        account_id,
        account_label,
        model_id,
        consumer_user_id,
        api_key_id,
        input_tokens,
        output_tokens,
        total_tokens,
        success,
        error,
        billing_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.accountDbId,
      account?.label ?? `Codex account #${result.accountDbId}`,
      result.modelId,
      context.consumerUserId,
      context.consumerApiKeyId,
      inputTokens,
      outputTokens,
      totalTokens,
      result.success ? 1 : 0,
      error,
      result.success ? 'pending' : 'failed',
    );

    db.prepare(`
      INSERT INTO codex_usage_stats (
        account_id, model_id, api_key_id, request_count,
        input_tokens, output_tokens, total_tokens,
        success_count, error_count, last_error, last_used_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(account_id, model_id, api_key_id) DO UPDATE SET
        request_count = request_count + 1,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        success_count = success_count + excluded.success_count,
        error_count = error_count + excluded.error_count,
        last_error = excluded.last_error,
        last_used_at = datetime('now'),
        updated_at = datetime('now')
    `).run(
      result.accountDbId,
      result.modelId,
      aggregateApiKeyId,
      inputTokens,
      outputTokens,
      totalTokens,
      result.success ? 1 : 0,
      result.success ? 0 : 1,
      error,
    );

    if (result.success) {
      db.prepare(`
        UPDATE codex_oauth_accounts
        SET status='healthy', last_used_at=datetime('now'),
            last_error=NULL, updated_at=datetime('now')
        WHERE id=?
      `).run(result.accountDbId);
    } else if (result.quotaExhausted) {
      db.prepare(`
        UPDATE codex_oauth_accounts
        SET quota_used_percent=100,
            quota_remaining_percent=0,
            cooldown_until=COALESCE(
              CASE
                WHEN quota_reset_at IS NOT NULL
                  AND datetime(quota_reset_at) > datetime('now')
                THEN datetime(quota_reset_at)
              END,
              datetime('now', '+1 hour')
            ),
            last_used_at=datetime('now'),
            last_error=?,
            updated_at=datetime('now')
        WHERE id=?
      `).run(error, result.accountDbId);
    } else if (result.authenticationFailure) {
      db.prepare(`
        UPDATE codex_oauth_accounts
        SET status='unhealthy', last_used_at=datetime('now'),
            last_error=?, updated_at=datetime('now')
        WHERE id=?
      `).run(error, result.accountDbId);
      const bindings = db.prepare(`SELECT subpool_id subpoolId FROM resource_subpool_bindings
        WHERE codex_account_id = ? AND status = 'active'`).all(result.accountDbId) as Array<{ subpoolId: number }>;
      if (bindings.length === 0) {
        raiseResourceAlert(db, { severity: 'critical', alertType: 'codex_oauth_invalid',
          sourceType: 'codex_account', sourceId: result.accountDbId,
          message: `Codex OAuth account ${result.accountDbId} authentication failed`, details: { error } });
      } else {
        for (const binding of bindings) {
          raiseResourceAlert(db, { severity: 'critical', alertType: 'codex_oauth_invalid',
            sourceType: 'codex_account_subpool', sourceId: `${result.accountDbId}:${binding.subpoolId}`,
            subpoolId: binding.subpoolId,
            message: `Dedicated Codex account ${result.accountDbId} authentication failed`,
            details: { accountId: result.accountDbId, error } });
        }
      }
    } else {
      db.prepare(`
        UPDATE codex_oauth_accounts
        SET last_used_at=datetime('now'), last_error=?, updated_at=datetime('now')
        WHERE id=?
      `).run(error, result.accountDbId);
    }

    return Number(inserted.lastInsertRowid);
  })();

  setCodexUsageRecordId(recordId);
  return recordId;
}

/** Use upstream-reported token counts for Codex billing and request logs. */
export function getCodexUsageTokens(
  db: Db,
  recordId: number,
): CodexUsageTokens | null {
  const row = db.prepare(`
    SELECT
      input_tokens AS inputTokens,
      output_tokens AS outputTokens
    FROM codex_usage_records
    WHERE id = ?
  `).get(recordId) as CodexUsageTokens | undefined;

  return row ?? null;
}

/**
 * Copy the generic wallet settlement result and the exact price snapshot onto
 * the Codex ledger. This does not charge again; it only links both ledgers.
 */
export function finalizeCodexUsageRecord(
  db: Db,
  recordId: number,
  requestId: number,
): void {
  const row = db.prepare(`
    SELECT
      r.status AS requestStatus,
      r.model_id AS modelId,
      r.billing_amount_micro AS billingAmountMicro,
      r.billing_status AS billingStatus,
      b.input_price_micro_per_million AS inputPrice,
      b.output_price_micro_per_million AS outputPrice,
      b.multiplier_milli AS multiplier
    FROM requests r
    LEFT JOIN model_billing_rules b
      ON b.platform = r.platform
     AND b.model_id = r.model_id
    WHERE r.id = ?
  `).get(requestId) as {
    requestStatus: string;
    modelId: string;
    billingAmountMicro: number;
    billingStatus: string;
    inputPrice: number | null;
    outputPrice: number | null;
    multiplier: number | null;
  } | undefined;

  if (!row) return;

  const billingStatus = row.requestStatus !== 'success'
    ? 'failed'
    : row.billingStatus === 'charged'
      ? 'charged'
      : row.billingStatus === 'free'
        ? 'free'
        : row.billingStatus === 'exempt'
          ? 'exempt'
          : 'failed';

  db.prepare(`
    UPDATE codex_usage_records
    SET request_id = ?,
        model_id = ?,
        billing_amount_micro = ?,
        billing_status = ?,
        input_price_micro_per_million = ?,
        output_price_micro_per_million = ?,
        multiplier_milli = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    requestId,
    row.modelId,
    Number(row.billingAmountMicro || 0),
    billingStatus,
    row.inputPrice,
    row.outputPrice,
    row.multiplier,
    recordId,
  );
}

export function getCodexUsageStats() {
  const db = getDb();

  const summary = db.prepare(`
    SELECT
      COALESCE(SUM(request_count), 0) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(success_count), 0) AS success_count,
      COALESCE(SUM(error_count), 0) AS error_count
    FROM codex_usage_stats
  `).get() as Record<string, number>;

  const billed = db.prepare(`
    SELECT COALESCE(SUM(billing_amount_micro), 0) AS billed_micro
    FROM codex_usage_records
    WHERE billing_status = 'charged'
  `).get() as { billed_micro: number };

  const accounts = db.prepare(`
    WITH usage AS (
      SELECT account_id,
        SUM(request_count) AS request_count,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(total_tokens) AS total_tokens,
        SUM(success_count) AS success_count,
        SUM(error_count) AS error_count,
        MAX(last_used_at) AS last_used_at
      FROM codex_usage_stats
      GROUP BY account_id
    ), revenue AS (
      SELECT account_id, SUM(billing_amount_micro) AS billed_micro
      FROM codex_usage_records
      WHERE billing_status = 'charged'
      GROUP BY account_id
    )
    SELECT
      a.id,
      a.account_id,
      a.label,
      a.enabled,
      a.status,
      COALESCE(u.request_count, 0) AS request_count,
      COALESCE(u.input_tokens, 0) AS input_tokens,
      COALESCE(u.output_tokens, 0) AS output_tokens,
      COALESCE(u.total_tokens, 0) AS total_tokens,
      COALESCE(u.success_count, 0) AS success_count,
      COALESCE(u.error_count, 0) AS error_count,
      COALESCE(r.billed_micro, 0) AS billed_micro,
      COALESCE(u.last_used_at, a.last_used_at) AS last_used_at,
      a.last_error
    FROM codex_oauth_accounts a
    LEFT JOIN usage u ON u.account_id = a.id
    LEFT JOIN revenue r ON r.account_id = a.id
    ORDER BY request_count DESC, a.id DESC
  `).all();

  const models = db.prepare(`
    WITH revenue AS (
      SELECT model_id, SUM(billing_amount_micro) AS billed_micro
      FROM codex_usage_records
      WHERE billing_status = 'charged'
      GROUP BY model_id
    )
    SELECT
      s.model_id,
      SUM(s.request_count) AS request_count,
      SUM(s.input_tokens) AS input_tokens,
      SUM(s.output_tokens) AS output_tokens,
      SUM(s.total_tokens) AS total_tokens,
      SUM(s.success_count) AS success_count,
      SUM(s.error_count) AS error_count,
      COALESCE(r.billed_micro, 0) AS billed_micro,
      MAX(s.last_used_at) AS last_used_at
    FROM codex_usage_stats s
    LEFT JOIN revenue r ON r.model_id = s.model_id
    GROUP BY s.model_id
    ORDER BY request_count DESC, s.model_id ASC
  `).all();

  const errors = db.prepare(`
    SELECT
      r.id,
      r.account_id,
      r.account_label,
      r.model_id,
      r.error,
      r.created_at,
      u.email AS user_email,
      k.name AS api_key_name
    FROM codex_usage_records r
    LEFT JOIN users u ON u.id = r.consumer_user_id
    LEFT JOIN consumer_api_keys k ON k.id = r.api_key_id
    WHERE r.success = 0
    ORDER BY r.id DESC
    LIMIT 50
  `).all();

  const recent = db.prepare(`
    SELECT
      r.id,
      r.account_id,
      r.account_label,
      r.model_id,
      r.input_tokens,
      r.output_tokens,
      r.total_tokens,
      r.success,
      r.error,
      r.billing_amount_micro,
      r.billing_status,
      r.created_at,
      u.email AS user_email,
      k.name AS api_key_name
    FROM codex_usage_records r
    LEFT JOIN users u ON u.id = r.consumer_user_id
    LEFT JOIN consumer_api_keys k ON k.id = r.api_key_id
    ORDER BY r.id DESC
    LIMIT 100
  `).all();

  return {
    summary: {
      ...summary,
      billed_micro: Number(billed.billed_micro || 0),
    },
    accounts,
    models,
    errors,
    recent,
  };
}
