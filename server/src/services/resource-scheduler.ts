import type { Db } from '../db/types.js';

export class ResourceDispatchError extends Error {
  constructor(public readonly code: 'resource_binding_unavailable' | 'scheduled_not_enabled', message: string) { super(message); }
}

export function selectCodexExecution(db: Db, input: { subpoolId: number; reservationId: number; correlationId: string; modelId?: string; skipAccountIds?: Set<number> }) {
  const subpool = db.prepare(`SELECT mode FROM resource_subpools WHERE id = ? AND status = 'active'`).get(input.subpoolId) as { mode: string } | undefined;
  if (!subpool) throw new ResourceDispatchError('resource_binding_unavailable', 'Codex subpool is not active.');
  if (subpool.mode === 'scheduled') throw new ResourceDispatchError('scheduled_not_enabled', 'Scheduled resource execution is not enabled in V1.');
  const row = db.prepare(`SELECT a.id accountId, am.model_id modelId
    FROM resource_subpool_bindings b
    JOIN codex_oauth_accounts a ON a.id = b.codex_account_id
    JOIN codex_oauth_account_models am ON am.account_id = a.id AND am.enabled = 1
    JOIN model_billing_rules br ON br.platform = 'openai-codex' AND br.model_id = am.model_id AND br.billing_enabled = 1
    WHERE b.subpool_id = ? AND b.status = 'active' AND a.enabled = 1
      AND a.resource_scope = 'resource_subpool' AND a.status IN ('healthy','unknown')
      AND (a.cooldown_until IS NULL OR a.cooldown_until <= datetime('now'))
      AND (? IS NULL OR am.model_id = ?) ORDER BY am.model_id LIMIT 1`).get(input.subpoolId, input.modelId ?? null, input.modelId ?? null) as { accountId: number; modelId: string } | undefined;
  if (!row || input.skipAccountIds?.has(row.accountId)) throw new ResourceDispatchError('resource_binding_unavailable', 'The dedicated Codex account is unavailable.');
  const inserted = db.prepare(`INSERT INTO resource_dispatches (request_correlation_id, subpool_id, codex_account_id, quota_reservation_id, model_id, decision_reason)
    VALUES (?, ?, ?, ?, ?, 'dedicated_binding')`).run(input.correlationId, input.subpoolId, row.accountId, input.reservationId, row.modelId);
  return { ...row, dispatchId: Number(inserted.lastInsertRowid) };
}

export function finalizeResourceDispatch(db: Db, dispatchId: number, succeeded: boolean, error?: string | null): void {
  db.prepare(`UPDATE resource_dispatches SET status = ?, error = ?, completed_at = datetime('now') WHERE id = ? AND status IN ('selected','started')`).run(succeeded ? 'succeeded' : 'failed', error ?? null, dispatchId);
}
