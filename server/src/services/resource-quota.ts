import { randomUUID } from 'crypto';
import type { Db } from '../db/types.js';

export type ResourceQuotaErrorCode =
  | 'resource_entitlement_required'
  | 'resource_subpool_inactive'
  | 'resource_quota_exhausted';

export class ResourceQuotaError extends Error {
  constructor(public readonly code: ResourceQuotaErrorCode, message: string) {
    super(message);
  }
}

export function estimateCodexQuotaUnits(body: unknown): number {
  const request = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const serialized = JSON.stringify(request.messages ?? request.input ?? '');
  const inputEstimate = Math.max(1, Math.ceil(serialized.length / 4));
  const rawOutput = Number(request.max_output_tokens ?? request.max_tokens ?? 1000);
  const outputEstimate = Number.isFinite(rawOutput) ? Math.max(1, Math.min(32_000, Math.trunc(rawOutput))) : 1000;
  return Math.min(Number.MAX_SAFE_INTEGER, inputEstimate + outputEstimate);
}

interface EntitlementRow {
  subpoolId: number; memberId: number; periodId: number; memberQuotaId: number;
  mode: 'dedicated' | 'scheduled'; groupAllocation: number; groupUsed: number;
  groupReserved: number; memberAllocation: number; memberUsed: number; memberReserved: number;
}

export function reserveSubpoolQuota(db: Db, userId: number, consumerApiKeyId: number, units: number) {
  const requested = Math.max(1, Math.trunc(units));
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT s.id subpoolId, m.id memberId, p.id periodId, q.id memberQuotaId,
        s.mode mode, p.allocation_units groupAllocation, p.used_units groupUsed,
        p.reserved_units groupReserved, q.allocation_units memberAllocation,
        q.used_units memberUsed, q.reserved_units memberReserved
      FROM resource_subpool_members m
      JOIN resource_subpools s ON s.id = m.subpool_id
      JOIN resource_subpool_quota_periods p ON p.subpool_id = s.id AND p.status = 'active'
      JOIN resource_member_quotas q ON q.member_id = m.id AND q.subpool_period_id = p.id AND q.status = 'active'
      WHERE m.user_id = ? AND m.consumer_api_key_id = ? AND m.status = 'active' AND s.status = 'active'
        AND (s.starts_at IS NULL OR datetime(s.starts_at) <= datetime('now'))
        AND (s.ends_at IS NULL OR datetime(s.ends_at) > datetime('now'))
        AND datetime(p.starts_at) <= datetime('now')
        AND (p.resets_at IS NULL OR datetime(p.resets_at) > datetime('now'))
      ORDER BY s.id LIMIT 1
    `).get(userId, consumerApiKeyId) as EntitlementRow | undefined;
    if (!row) {
      const member = db.prepare(`SELECT 1 FROM resource_subpool_members WHERE user_id = ? AND consumer_api_key_id = ? AND status = 'active'`).get(userId, consumerApiKeyId);
      throw new ResourceQuotaError(member ? 'resource_subpool_inactive' : 'resource_entitlement_required', member ? 'No active quota period is available.' : 'An active Codex subpool entitlement is required.');
    }
    if (row.groupAllocation - row.groupUsed - row.groupReserved < requested ||
        row.memberAllocation - row.memberUsed - row.memberReserved < requested) {
      throw new ResourceQuotaError('resource_quota_exhausted', 'Codex subpool quota is exhausted.');
    }
    const group = db.prepare(`UPDATE resource_subpool_quota_periods SET reserved_units = reserved_units + ? WHERE id = ? AND allocation_units - used_units - reserved_units >= ?`).run(requested, row.periodId, requested);
    const member = db.prepare(`UPDATE resource_member_quotas SET reserved_units = reserved_units + ? WHERE id = ? AND allocation_units - used_units - reserved_units >= ?`).run(requested, row.memberQuotaId, requested);
    if (group.changes !== 1 || member.changes !== 1) throw new ResourceQuotaError('resource_quota_exhausted', 'Codex subpool quota is exhausted.');
    const correlationId = randomUUID();
    const inserted = db.prepare(`INSERT INTO resource_quota_reservations
      (request_correlation_id, subpool_id, period_id, member_quota_id, reserved_units, expires_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+15 minutes'))`).run(correlationId, row.subpoolId, row.periodId, row.memberQuotaId, requested);
    const reservationId = Number(inserted.lastInsertRowid);
    db.prepare(`INSERT INTO resource_quota_ledger (subpool_id, period_id, member_id, reservation_id, type, delta_units, balance_after_units, reason)
      VALUES (?, ?, ?, ?, 'reservation', ?, ?, 'request reservation')`).run(row.subpoolId, row.periodId, row.memberId, reservationId, -requested, row.memberAllocation - row.memberUsed - row.memberReserved - requested);
    return { reservationId, requestCorrelationId: correlationId, subpoolId: row.subpoolId, memberId: row.memberId, mode: row.mode, reservedUnits: requested };
  })();
}

export type ResourceSettlementStatus = 'failed_before_usage' | 'partial' | 'success';

export function finalizeSubpoolQuota(db: Db, reservationId: number, requestId: number | null, actualUnits: number | null, settlementStatus: ResourceSettlementStatus) {
  return db.transaction(() => {
    const row = db.prepare(`SELECT r.*, q.member_id memberId, q.allocation_units memberAllocation, q.used_units memberUsed
      FROM resource_quota_reservations r JOIN resource_member_quotas q ON q.id = r.member_quota_id WHERE r.id = ?`).get(reservationId) as any;
    if (!row || row.status !== 'reserved') return { status: 'already_finalized' as const };
    const consumesQuota = settlementStatus !== 'failed_before_usage';
    const status = consumesQuota ? 'settled' : 'failed';
    const actual = consumesQuota ? Math.max(1, Math.trunc(actualUnits ?? 0)) : 0;
    db.prepare(`UPDATE resource_subpool_quota_periods SET reserved_units = max(0, reserved_units - ?), used_units = used_units + ? WHERE id = ?`).run(row.reserved_units, actual, row.period_id);
    db.prepare(`UPDATE resource_member_quotas SET reserved_units = max(0, reserved_units - ?), used_units = used_units + ? WHERE id = ?`).run(row.reserved_units, actual, row.member_quota_id);
    db.prepare(`UPDATE resource_quota_reservations SET actual_units = ?, request_id = ?, status = ?,
      settlement_status = ?, settled_at = datetime('now') WHERE id = ? AND status = 'reserved'`)
      .run(actual, requestId, status, settlementStatus, reservationId);
    db.prepare(`INSERT INTO resource_quota_ledger (subpool_id, period_id, member_id, reservation_id, request_id, type, delta_units, balance_after_units, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.subpool_id, row.period_id, row.memberId, reservationId, requestId, consumesQuota ? 'settlement' : 'release', consumesQuota ? -actual : row.reserved_units, Math.max(0, row.memberAllocation - row.memberUsed - actual), consumesQuota ? `${settlementStatus} token settlement` : 'request failed before usage');
    return { status, settlementStatus };
  })();
}

export function releaseSubpoolQuota(db: Db, reservationId: number) {
  return finalizeSubpoolQuota(db, reservationId, null, null, 'failed_before_usage');
}
