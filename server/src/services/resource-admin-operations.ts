import type { Db } from '../db/types.js';
import { recordResourceAdminAudit } from './resource-admin-audit.js';

export function listResourceProductStats(db: Db) {
  return db.prepare(`SELECT p.id, p.product_key productKey, p.version, p.name, p.status,
    p.price_micro priceMicro, p.member_limit memberLimit,
    p.duration_value durationValue, p.duration_unit durationUnit,
    p.quota_allocation_type quotaAllocationType,
    p.total_quota_units totalQuotaUnits, p.member_quota_units memberQuotaUnits,
    p.meter_version meterVersion, p.group_timeout_minutes groupTimeoutMinutes,
    p.refund_window_minutes refundWindowMinutes, p.created_at createdAt,
    COUNT(DISTINCT o.id) orderCount,
    SUM(CASE WHEN o.order_status = 'pending_payment' THEN 1 ELSE 0 END) pendingPaymentCount,
    SUM(CASE WHEN o.order_status = 'paid_waiting_group' THEN 1 ELSE 0 END) waitingOrderCount,
    SUM(CASE WHEN o.order_status = 'grouped' THEN 1 ELSE 0 END) groupedOrderCount,
    SUM(CASE WHEN o.order_status = 'active' THEN 1 ELSE 0 END) activeOrderCount,
    COUNT(DISTINCT s.id) subpoolCount,
    COUNT(DISTINCT CASE WHEN s.status = 'active' THEN s.id END) activeSubpoolCount
    FROM resource_products p
    LEFT JOIN resource_orders o ON o.product_id = p.id
    LEFT JOIN resource_subpools s ON s.product_id = p.id
    GROUP BY p.id ORDER BY p.id DESC`).all();
}

export function listResourceSubpools(db: Db, status?: string) {
  return db.prepare(`SELECT s.id, s.name, s.mode, s.status, s.member_limit memberLimit,
    s.starts_at startsAt, s.ends_at endsAt, s.activated_at activatedAt,
    p.id productId, p.name productName, p.version productVersion,
    COUNT(DISTINCT m.id) memberCount,
    b.codex_account_id accountId, a.label accountLabel, a.status accountStatus,
    s.pending_codex_account_id pendingAccountId,
    q.allocation_units allocationUnits, q.used_units usedUnits, q.reserved_units reservedUnits
    FROM resource_subpools s
    LEFT JOIN resource_products p ON p.id = s.product_id
    LEFT JOIN resource_subpool_members m ON m.subpool_id = s.id
    LEFT JOIN resource_subpool_bindings b ON b.subpool_id = s.id AND b.status = 'active'
    LEFT JOIN codex_oauth_accounts a ON a.id = b.codex_account_id
    LEFT JOIN resource_subpool_quota_periods q ON q.subpool_id = s.id AND q.status = 'active'
    WHERE (? IS NULL OR s.status = ?)
    GROUP BY s.id ORDER BY s.id DESC`).all(status ?? null, status ?? null);
}

export function getResourceSubpoolDetail(db: Db, subpoolId: number) {
  const pool = db.prepare(`SELECT s.*, p.name productName, p.version productVersion,
    b.codex_account_id accountId, a.label accountLabel, a.status accountStatus,
    a.quota_remaining_percent accountQuotaRemainingPercent, a.quota_reset_at accountQuotaResetAt,
    q.id quotaPeriodId, q.allocation_units allocationUnits, q.used_units usedUnits,
    q.reserved_units reservedUnits, q.resets_at quotaResetsAt
    FROM resource_subpools s
    LEFT JOIN resource_products p ON p.id = s.product_id
    LEFT JOIN resource_subpool_bindings b ON b.subpool_id = s.id AND b.status = 'active'
    LEFT JOIN codex_oauth_accounts a ON a.id = b.codex_account_id
    LEFT JOIN resource_subpool_quota_periods q ON q.subpool_id = s.id AND q.status = 'active'
    WHERE s.id = ?`).get(subpoolId);
  if (!pool) return null;
  const members = db.prepare(`SELECT m.id, m.user_id userId, u.email, m.status,
    m.consumer_api_key_id consumerApiKeyId, k.name apiKeyName, m.resource_order_id orderId,
    o.order_no orderNo, o.order_status orderStatus,
    q.id memberQuotaId, q.allocation_units allocationUnits, q.used_units usedUnits,
    q.reserved_units reservedUnits, q.status quotaStatus
    FROM resource_subpool_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN consumer_api_keys k ON k.id = m.consumer_api_key_id
    LEFT JOIN resource_orders o ON o.id = m.resource_order_id
    LEFT JOIN resource_subpool_quota_periods p ON p.subpool_id = m.subpool_id AND p.status = 'active'
    LEFT JOIN resource_member_quotas q ON q.member_id = m.id AND q.subpool_period_id = p.id
    WHERE m.subpool_id = ? ORDER BY m.id`).all(subpoolId);
  return { pool, members };
}

export function listAvailableCodexAccounts(db: Db) {
  return db.prepare(`SELECT a.id, a.label, a.account_id accountExternalId, a.enabled, a.status,
    a.plan_type planType, a.quota_remaining_percent quotaRemainingPercent,
    a.quota_reset_at quotaResetAt, a.quota_synced_at quotaSyncedAt,
    GROUP_CONCAT(DISTINCT am.model_id) models
    FROM codex_oauth_accounts a
    LEFT JOIN resource_subpool_bindings b ON b.codex_account_id = a.id AND b.status IN ('active', 'migrating')
    LEFT JOIN resource_subpools pending ON pending.pending_codex_account_id = a.id AND pending.status = 'waiting_resource'
    LEFT JOIN codex_oauth_account_models am ON am.account_id = a.id AND am.enabled = 1
    WHERE a.enabled = 1 AND a.status = 'healthy'
      AND a.resource_scope = 'resource_subpool'
      AND b.id IS NULL AND pending.id IS NULL
    GROUP BY a.id ORDER BY a.id DESC`).all();
}

export function getResourceMemberQuota(db: Db, subpoolId: number, memberId: number) {
  return db.prepare(`SELECT m.id memberId, m.user_id userId, u.email,
    p.id periodId, p.allocation_units subpoolAllocationUnits,
    p.used_units subpoolUsedUnits, p.reserved_units subpoolReservedUnits,
    q.id memberQuotaId, q.allocation_units allocationUnits,
    q.used_units usedUnits, q.reserved_units reservedUnits,
    q.allocation_units - q.used_units - q.reserved_units remainingUnits,
    p.resets_at resetsAt
    FROM resource_subpool_members m
    JOIN users u ON u.id = m.user_id
    JOIN resource_subpool_quota_periods p ON p.subpool_id = m.subpool_id AND p.status = 'active'
    JOIN resource_member_quotas q ON q.member_id = m.id AND q.subpool_period_id = p.id
    WHERE m.subpool_id = ? AND m.id = ?`).get(subpoolId, memberId) ?? null;
}

export function listResourceUsageRecords(db: Db, input: { subpoolId: number; memberId?: number; limit?: number }) {
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
  return db.prepare(`SELECT DISTINCT c.id, c.request_id requestId, c.model_id modelId,
    c.input_tokens inputTokens, c.output_tokens outputTokens, c.total_tokens totalTokens,
    c.success, c.error, c.created_at createdAt,
    m.id memberId, m.user_id userId, u.email,
    r.actual_units quotaUnits
    FROM resource_quota_reservations r
    JOIN resource_member_quotas q ON q.id = r.member_quota_id
    JOIN resource_subpool_members m ON m.id = q.member_id
    JOIN users u ON u.id = m.user_id
    LEFT JOIN codex_usage_records c ON c.request_id = r.request_id
    WHERE r.subpool_id = ? AND (? IS NULL OR m.id = ?) AND c.id IS NOT NULL
    ORDER BY c.id DESC LIMIT ?`).all(input.subpoolId, input.memberId ?? null, input.memberId ?? null, limit);
}

export function adjustResourceMemberQuota(db: Db, input: {
  subpoolId: number; memberId: number; deltaUnits: number; reason: string; adminId: number;
}) {
  const delta = Math.trunc(input.deltaUnits);
  const reason = input.reason.trim();
  if (!Number.isSafeInteger(delta) || delta === 0 || !reason) throw new Error('A non-zero deltaUnits and reason are required');
  return db.transaction(() => {
    const row = db.prepare(`SELECT q.id quotaId, q.allocation_units allocationUnits,
      q.used_units usedUnits, q.reserved_units reservedUnits,
      p.id periodId, p.allocation_units poolAllocationUnits,
      (SELECT COALESCE(SUM(mq.allocation_units), 0) FROM resource_member_quotas mq WHERE mq.subpool_period_id = p.id) allocatedMemberUnits
      FROM resource_subpool_members m
      JOIN resource_subpool_quota_periods p ON p.subpool_id = m.subpool_id AND p.status = 'active'
      JOIN resource_member_quotas q ON q.member_id = m.id AND q.subpool_period_id = p.id
      WHERE m.subpool_id = ? AND m.id = ? AND q.status = 'active'`).get(input.subpoolId, input.memberId) as any;
    if (!row) throw new Error('Active member quota was not found');
    const nextAllocation = row.allocationUnits + delta;
    if (nextAllocation < row.usedUnits + row.reservedUnits) throw new Error('Adjusted quota cannot be below used and reserved units');
    if (delta > 0 && row.allocatedMemberUnits + delta > row.poolAllocationUnits) throw new Error('Adjusted member quotas exceed subpool allocation');
    db.prepare(`UPDATE resource_member_quotas SET allocation_units = ? WHERE id = ?`).run(nextAllocation, row.quotaId);
    const balance = nextAllocation - row.usedUnits - row.reservedUnits;
    const ledger = db.prepare(`INSERT INTO resource_quota_ledger
      (subpool_id, period_id, member_id, type, delta_units, balance_after_units, reason)
      VALUES (?, ?, ?, 'adjustment', ?, ?, ?)`).run(input.subpoolId, row.periodId, input.memberId, delta, balance, reason);
    recordResourceAdminAudit(db, {
      adminUserId: input.adminId, action: 'member_quota_adjusted', targetType: 'resource_subpool_member',
      targetId: input.memberId, subpoolId: input.subpoolId,
      details: { deltaUnits: delta, reason, previousAllocationUnits: row.allocationUnits, allocationUnits: nextAllocation },
    });
    return { memberId: input.memberId, allocationUnits: nextAllocation, remainingUnits: balance, ledgerId: Number(ledger.lastInsertRowid) };
  })();
}
