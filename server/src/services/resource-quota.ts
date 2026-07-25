import { randomUUID } from 'crypto';
import type { Db } from '../db/types.js';

export type ResourceQuotaErrorCode =
  | 'resource_entitlement_required'
  | 'resource_subpool_inactive'
  | 'resource_quota_exhausted'
  | 'resource_official_quota_protected';

export class ResourceQuotaError extends Error {
  constructor(public readonly code: ResourceQuotaErrorCode, message: string) {
    super(message);
  }
}

export interface ResourceQuotaEstimate {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  inputMultiplierMicros: number;
  cachedInputMultiplierMicros?: number;
  outputMultiplierMicros: number;
  units: number;
}

export const RESOURCE_TOKENS_PER_POINT = 1500;

function requestModel(body: unknown): string {
  const request = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return String(request.model ?? 'codex').trim() || 'codex';
}

export function calculateResourcePoints(inputTokens: number, outputTokens: number, inputMultiplierMicros: number,
  outputMultiplierMicros: number, cachedInputTokens = 0, cachedInputMultiplierMicros = inputMultiplierMicros): number {
  const totalInput = Math.max(0, Math.trunc(inputTokens));
  const cachedInput = Math.min(totalInput, Math.max(0, Math.trunc(cachedInputTokens)));
  const weighted = (totalInput - cachedInput) * Math.max(1, Math.trunc(inputMultiplierMicros))
    + cachedInput * Math.max(1, Math.trunc(cachedInputMultiplierMicros))
    + Math.max(0, Math.trunc(outputTokens)) * Math.max(1, Math.trunc(outputMultiplierMicros));
  return Math.max(1, Math.ceil(weighted / (1_000_000 * RESOURCE_TOKENS_PER_POINT)));
}

export function estimateCodexQuotaUnits(db: Db, body: unknown): ResourceQuotaEstimate {
  const request = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const serialized = JSON.stringify(request.messages ?? request.input ?? '');
  const inputEstimate = Math.max(1, Math.ceil(serialized.length / 4));
  const rawOutput = Number(request.max_output_tokens ?? request.max_tokens ?? 1000);
  const outputEstimate = Number.isFinite(rawOutput) ? Math.max(1, Math.min(32_000, Math.trunc(rawOutput))) : 1000;
  const modelId = requestModel(body);
  const policy = db.prepare(`SELECT default_input_multiplier_micros inputMultiplierMicros,
    default_cached_input_multiplier_micros cachedInputMultiplierMicros,
    default_output_multiplier_micros outputMultiplierMicros FROM resource_quota_policy WHERE id = 1`).get() as {
      inputMultiplierMicros: number; cachedInputMultiplierMicros: number; outputMultiplierMicros: number;
    };
  const rule = db.prepare(`SELECT input_multiplier_micros inputMultiplierMicros,
    cached_input_multiplier_micros cachedInputMultiplierMicros,
    output_multiplier_micros outputMultiplierMicros FROM resource_model_multipliers
    WHERE model_id = ? AND enabled = 1`).get(modelId) as typeof policy | undefined;
  const inputMultiplierMicros = rule?.inputMultiplierMicros ?? policy.inputMultiplierMicros;
  const cachedInputMultiplierMicros = rule?.cachedInputMultiplierMicros ?? policy.cachedInputMultiplierMicros;
  const outputMultiplierMicros = rule?.outputMultiplierMicros ?? policy.outputMultiplierMicros;
  return { modelId, inputTokens: inputEstimate, outputTokens: outputEstimate, inputMultiplierMicros,
    cachedInputMultiplierMicros, outputMultiplierMicros,
    units: calculateResourcePoints(inputEstimate, outputEstimate, inputMultiplierMicros, outputMultiplierMicros) };
}

interface EntitlementRow {
  subpoolId: number; memberId: number; periodId: number; memberQuotaId: number;
  mode: 'dedicated' | 'scheduled'; groupAllocation: number; groupUsed: number;
  groupReserved: number; memberAllocation: number; memberUsed: number; memberReserved: number;
  officialRemainingPercent: number | null; officialResetAt: string | null; officialFloorPercent: number;
  quotaStage: number; stageOneFloorPercent: number; stageTwoMultiplierFactorMicros: number;
  stageStartedOfficialPercent: number | null; promisedMemberUnits: number | null;
  quotaPhase: number; phaseMultiplierFactorMicros: number;
}

export function reserveSubpoolQuota(db: Db, userId: number, consumerApiKeyId: number, estimateOrUnits: ResourceQuotaEstimate | number) {
  const estimate = typeof estimateOrUnits === 'number' ? {
    modelId: 'codex', inputTokens: 0, outputTokens: 0, inputMultiplierMicros: 1_000_000,
    cachedInputMultiplierMicros: 250_000, outputMultiplierMicros: 1_000_000, units: estimateOrUnits,
  } : estimateOrUnits;
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT s.id subpoolId, m.id memberId, p.id periodId, q.id memberQuotaId,
        s.mode mode, p.allocation_units groupAllocation, p.used_units groupUsed,
        p.reserved_units groupReserved, q.allocation_units memberAllocation,
        q.used_units memberUsed, q.reserved_units memberReserved,
        a.quota_remaining_percent officialRemainingPercent, a.quota_reset_at officialResetAt,
        policy.official_quota_floor_percent officialFloorPercent,
        s.quota_stage quotaStage, s.stage_one_floor_percent stageOneFloorPercent,
        s.stage_two_multiplier_factor_micros stageTwoMultiplierFactorMicros,
        s.stage_started_official_percent stageStartedOfficialPercent,
        s.frozen_member_quota_units promisedMemberUnits,
        s.quota_phase quotaPhase, s.phase_multiplier_factor_micros phaseMultiplierFactorMicros
      FROM resource_subpool_members m
      JOIN resource_member_api_keys mk ON mk.member_id = m.id
      JOIN resource_subpools s ON s.id = m.subpool_id
      JOIN resource_subpool_quota_periods p ON p.subpool_id = s.id AND p.status = 'active'
      JOIN resource_member_quotas q ON q.member_id = m.id AND q.subpool_period_id = p.id AND q.status = 'active'
      LEFT JOIN resource_subpool_bindings b ON b.subpool_id = s.id AND b.status = 'active'
      LEFT JOIN codex_oauth_accounts a ON a.id = b.codex_account_id AND a.enabled = 1
      JOIN resource_quota_policy policy ON policy.id = 1
      WHERE m.user_id = ? AND mk.consumer_api_key_id = ? AND m.status = 'active' AND s.status = 'active'
        AND (s.starts_at IS NULL OR datetime(s.starts_at) <= datetime('now'))
        AND (s.ends_at IS NULL OR datetime(s.ends_at) > datetime('now'))
        AND datetime(p.starts_at) <= datetime('now')
        AND (p.resets_at IS NULL OR datetime(p.resets_at) > datetime('now'))
      ORDER BY s.id LIMIT 1
    `).get(userId, consumerApiKeyId) as EntitlementRow | undefined;
    if (!row) {
      const member = db.prepare(`SELECT 1 FROM resource_subpool_members m
        JOIN resource_member_api_keys mk ON mk.member_id = m.id
        WHERE m.user_id = ? AND mk.consumer_api_key_id = ? AND m.status = 'active'`).get(userId, consumerApiKeyId);
      throw new ResourceQuotaError(member ? 'resource_subpool_inactive' : 'resource_entitlement_required', member ? 'No active quota period is available.' : 'An active Codex subpool entitlement is required.');
    }
    const phaseFloors = [80, 60, 40, 20, row.officialFloorPercent];
    const activeFloorPercent = phaseFloors[Math.min(5, Math.max(1, row.quotaPhase)) - 1];
    if (row.officialRemainingPercent !== null
      && row.officialRemainingPercent <= activeFloorPercent
      && (row.officialResetAt === null || new Date(row.officialResetAt).getTime() > Date.now())) {
      throw new ResourceQuotaError('resource_official_quota_protected',
        `Official Codex quota reached the ${activeFloorPercent}% protection line.`);
    }
    const stageFactor = Math.max(1, row.phaseMultiplierFactorMicros);
    const effectiveInputMultiplierMicros = Math.max(1, Math.round(estimate.inputMultiplierMicros * stageFactor / 1_000_000));
    const effectiveCachedInputMultiplierMicros = Math.max(1, Math.round((estimate.cachedInputMultiplierMicros ?? 250_000) * stageFactor / 1_000_000));
    const effectiveOutputMultiplierMicros = Math.max(1, Math.round(estimate.outputMultiplierMicros * stageFactor / 1_000_000));
    const requested = typeof estimateOrUnits === 'number'
      ? Math.max(1, Math.trunc(estimate.units))
      : calculateResourcePoints(estimate.inputTokens, estimate.outputTokens,
        effectiveInputMultiplierMicros, effectiveOutputMultiplierMicros, 0, effectiveCachedInputMultiplierMicros);
    if (row.groupAllocation - row.groupUsed - row.groupReserved < requested ||
        row.memberAllocation - row.memberUsed - row.memberReserved < requested) {
      throw new ResourceQuotaError('resource_quota_exhausted', 'Codex subpool quota is exhausted.');
    }
    const group = db.prepare(`UPDATE resource_subpool_quota_periods SET reserved_units = reserved_units + ? WHERE id = ? AND allocation_units - used_units - reserved_units >= ?`).run(requested, row.periodId, requested);
    const member = db.prepare(`UPDATE resource_member_quotas SET reserved_units = reserved_units + ? WHERE id = ? AND allocation_units - used_units - reserved_units >= ?`).run(requested, row.memberQuotaId, requested);
    if (group.changes !== 1 || member.changes !== 1) throw new ResourceQuotaError('resource_quota_exhausted', 'Codex subpool quota is exhausted.');
    const correlationId = randomUUID();
    const inserted = db.prepare(`INSERT INTO resource_quota_reservations
      (request_correlation_id, subpool_id, period_id, member_quota_id, reserved_units, expires_at,
       model_id, input_multiplier_micros, cached_input_multiplier_micros,
       output_multiplier_micros, official_quota_percent_before)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+15 minutes'), ?, ?, ?, ?, ?)`).run(
        correlationId, row.subpoolId, row.periodId, row.memberQuotaId, requested,
        estimate.modelId, effectiveInputMultiplierMicros, effectiveCachedInputMultiplierMicros,
        effectiveOutputMultiplierMicros,
        row.officialRemainingPercent,
      );
    const reservationId = Number(inserted.lastInsertRowid);
    db.prepare(`INSERT INTO resource_quota_ledger (subpool_id, period_id, member_id, reservation_id, type, delta_units, balance_after_units, reason)
      VALUES (?, ?, ?, ?, 'reservation', ?, ?, 'request reservation')`).run(row.subpoolId, row.periodId, row.memberId, reservationId, -requested, row.memberAllocation - row.memberUsed - row.memberReserved - requested);
    return { reservationId, requestCorrelationId: correlationId, subpoolId: row.subpoolId, memberId: row.memberId, mode: row.mode, reservedUnits: requested };
  })();
}

export type ResourceSettlementStatus = 'failed_before_usage' | 'partial' | 'success';

export function finalizeSubpoolQuota(db: Db, reservationId: number, requestId: number | null,
  usageOrUnits: { inputTokens: number; cachedInputTokens?: number; outputTokens: number } | number | null, settlementStatus: ResourceSettlementStatus) {
  return db.transaction(() => {
    const row = db.prepare(`SELECT r.*, q.member_id memberId, q.allocation_units memberAllocation, q.used_units memberUsed
      FROM resource_quota_reservations r JOIN resource_member_quotas q ON q.id = r.member_quota_id WHERE r.id = ?`).get(reservationId) as any;
    if (!row || row.status !== 'reserved') return { status: 'already_finalized' as const };
    const consumesQuota = settlementStatus !== 'failed_before_usage';
    const status = consumesQuota ? 'settled' : 'failed';
    const usage = typeof usageOrUnits === 'object' && usageOrUnits !== null ? usageOrUnits : null;
    const actual = consumesQuota
      ? usage
        ? calculateResourcePoints(usage.inputTokens, usage.outputTokens, row.input_multiplier_micros,
          row.output_multiplier_micros, usage.cachedInputTokens ?? 0, row.cached_input_multiplier_micros)
        : Math.max(1, Math.trunc(typeof usageOrUnits === 'number' ? usageOrUnits : 0))
      : 0;
    db.prepare(`UPDATE resource_subpool_quota_periods SET reserved_units = max(0, reserved_units - ?), used_units = used_units + ? WHERE id = ?`).run(row.reserved_units, actual, row.period_id);
    db.prepare(`UPDATE resource_member_quotas SET reserved_units = max(0, reserved_units - ?), used_units = used_units + ? WHERE id = ?`).run(row.reserved_units, actual, row.member_quota_id);
    const officialAfter = db.prepare(`SELECT a.quota_remaining_percent remainingPercent
      FROM resource_subpool_bindings b JOIN codex_oauth_accounts a ON a.id = b.codex_account_id
      WHERE b.subpool_id = ? AND b.status = 'active' LIMIT 1`).get(row.subpool_id) as { remainingPercent: number | null } | undefined;
    db.prepare(`UPDATE resource_quota_reservations SET actual_units = ?, request_id = ?, status = ?,
      input_tokens = ?, cached_input_tokens = ?, output_tokens = ?,
      official_quota_percent_after = ?, settlement_status = ?, settled_at = datetime('now') WHERE id = ? AND status = 'reserved'`)
      .run(actual, requestId, status, usage?.inputTokens ?? null, usage?.cachedInputTokens ?? null, usage?.outputTokens ?? null,
        officialAfter?.remainingPercent ?? null, settlementStatus, reservationId);
    db.prepare(`INSERT INTO resource_quota_ledger (subpool_id, period_id, member_id, reservation_id, request_id, type, delta_units, balance_after_units, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.subpool_id, row.period_id, row.memberId, reservationId, requestId, consumesQuota ? 'settlement' : 'release', consumesQuota ? -actual : row.reserved_units, Math.max(0, row.memberAllocation - row.memberUsed - actual), consumesQuota ? `${settlementStatus} weighted point settlement` : 'request failed before usage');
    return { status, settlementStatus };
  })();
}

export function releaseSubpoolQuota(db: Db, reservationId: number) {
  return finalizeSubpoolQuota(db, reservationId, null, null, 'failed_before_usage');
}
