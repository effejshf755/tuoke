import type { Db } from '../db/types.js';

export function listPublishedResourceProducts(db: Db) {
  return db.prepare(`SELECT p.id, p.product_key productKey, p.version, p.name,
    p.description, p.resource_type resourceType, p.price_micro priceMicro,
    p.member_limit memberLimit, p.duration_value durationValue,
    p.duration_unit durationUnit, p.total_quota_units totalQuotaUnits,
    p.member_quota_units memberQuotaUnits, p.meter_version meterVersion,
    COALESCE((
      SELECT COUNT(*) FROM resource_subpool_members m
      WHERE m.subpool_id = (
        SELECT s.id FROM resource_subpools s
        WHERE s.product_id = p.id AND s.mode = 'dedicated' AND s.status = 'waiting_members'
        ORDER BY s.id ASC LIMIT 1
      )
    ), 0) waitingMembers
    FROM resource_products p
    WHERE p.status = 'published'
      AND (p.sale_starts_at IS NULL OR datetime(p.sale_starts_at) <= datetime('now'))
      AND (p.sale_ends_at IS NULL OR datetime(p.sale_ends_at) > datetime('now'))
    ORDER BY p.id DESC`).all();
}

export function getPublishedResourceProduct(db: Db, productId: number) {
  return db.prepare(`SELECT p.id, p.product_key productKey, p.version, p.name,
    p.description, p.resource_type resourceType, p.price_micro priceMicro,
    p.member_limit memberLimit, p.duration_value durationValue,
    p.duration_unit durationUnit, p.quota_allocation_type quotaAllocationType,
    p.total_quota_units totalQuotaUnits, p.member_quota_units memberQuotaUnits,
    p.meter_version meterVersion, p.group_timeout_minutes groupTimeoutMinutes,
    p.refund_window_minutes refundWindowMinutes,
    COALESCE((
      SELECT COUNT(*) FROM resource_subpool_members m
      WHERE m.subpool_id = (
        SELECT s.id FROM resource_subpools s
        WHERE s.product_id = p.id AND s.mode = 'dedicated' AND s.status = 'waiting_members'
        ORDER BY s.id ASC LIMIT 1
      )
    ), 0) waitingMembers
    FROM resource_products p
    WHERE p.id = ? AND p.status = 'published'
      AND (p.sale_starts_at IS NULL OR datetime(p.sale_starts_at) <= datetime('now'))
      AND (p.sale_ends_at IS NULL OR datetime(p.sale_ends_at) > datetime('now'))`).get(productId) ?? null;
}

export function listUserResourceOrders(db: Db, userId: number) {
  return db.prepare(`SELECT o.id, o.order_no orderNo, o.product_id productId,
    o.product_name_snapshot productName, o.product_version productVersion,
    o.price_micro priceMicro, o.member_limit_snapshot memberLimit,
    o.member_quota_units_snapshot memberQuotaUnits, o.order_status status,
    o.paid_at paidAt, o.refundable_until refundableUntil,
    o.refunded_at refundedAt, o.created_at createdAt,
    o.subpool_id subpoolId, s.status subpoolStatus,
    CASE WHEN s.id IS NULL THEN 0 ELSE
      (SELECT COUNT(*) FROM resource_subpool_members m WHERE m.subpool_id = s.id)
    END memberCount
    FROM resource_orders o
    LEFT JOIN resource_subpools s ON s.id = o.subpool_id
    WHERE o.user_id = ?
    ORDER BY o.id DESC`).all(userId);
}

export function listUserResourceSubscriptions(db: Db, userId: number) {
  return db.prepare(`SELECT s.id subpoolId, s.status, s.starts_at startsAt,
    s.ends_at endsAt, p.id productId, p.name productName, p.version productVersion,
    m.id memberId, m.activated_at activatedAt, m.expires_at memberExpiresAt,
    q.allocation_units totalQuotaUnits, q.used_units usedQuotaUnits,
    q.reserved_units reservedQuotaUnits,
    MAX(0, q.allocation_units - q.used_units - q.reserved_units) remainingQuotaUnits,
    period.resets_at quotaResetsAt, period.meter_version meterVersion
    FROM resource_subpool_members m
    JOIN resource_subpools s ON s.id = m.subpool_id AND s.status = 'active'
    JOIN resource_products p ON p.id = s.product_id
    JOIN resource_subpool_quota_periods period
      ON period.subpool_id = s.id AND period.status = 'active'
    JOIN resource_member_quotas q
      ON q.subpool_period_id = period.id AND q.member_id = m.id AND q.status = 'active'
    WHERE m.user_id = ? AND m.status = 'active'
    ORDER BY s.id DESC`).all(userId);
}

export function listUserResourceUsage(db: Db, userId: number, limit = 100) {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 100;
  return db.prepare(`SELECT r.id reservationId, r.request_id requestId,
    req.model_id modelId,
    COALESCE(r.actual_units, r.reserved_units) consumedQuotaUnits,
    COALESCE(req.input_tokens, 0) inputTokens,
    COALESCE(r.cached_input_tokens, 0) cachedInputTokens,
    COALESCE(req.output_tokens, 0) outputTokens, req.status,
    r.input_multiplier_micros / 1000000.0 inputMultiplier,
    r.cached_input_multiplier_micros / 1000000.0 cachedInputMultiplier,
    r.output_multiplier_micros / 1000000.0 outputMultiplier,
    r.official_quota_percent_before officialQuotaPercentBefore,
    r.official_quota_percent_after officialQuotaPercentAfter,
    COALESCE(req.latency_ms, 0) latencyMs,
    COALESCE(req.input_tokens, 0) + COALESCE(req.output_tokens, 0) totalTokens,
    COALESCE(r.settled_at, r.created_at) createdAt
    FROM resource_quota_reservations r
    JOIN resource_member_quotas q ON q.id = r.member_quota_id
    JOIN resource_subpool_members m ON m.id = q.member_id
    LEFT JOIN requests req ON req.id = r.request_id
    WHERE m.user_id = ? AND r.status = 'settled'
    ORDER BY r.id DESC LIMIT ?`).all(userId, safeLimit);
}

export function getUserResourceSubscriptionDetail(db: Db, userId: number, subpoolId: number) {
  const subscription = db.prepare(`SELECT s.id subpoolId, s.status, s.starts_at startsAt, s.ends_at endsAt,
    p.name productName, p.version productVersion, m.id memberId,
    q.allocation_units totalQuotaUnits, q.used_units usedQuotaUnits, q.reserved_units reservedQuotaUnits,
    MAX(0, q.allocation_units - q.used_units - q.reserved_units) remainingQuotaUnits,
    period.resets_at quotaResetsAt, period.meter_version meterVersion,
    a.plan_type accountPlanType, a.status accountStatus,
    a.quota_remaining_percent accountQuotaRemainingPercent, a.quota_reset_at accountQuotaResetAt,
    a.quota_synced_at accountQuotaSyncedAt
    FROM resource_subpool_members m
    JOIN resource_subpools s ON s.id = m.subpool_id
    JOIN resource_products p ON p.id = s.product_id
    JOIN resource_subpool_quota_periods period ON period.subpool_id = s.id AND period.status = 'active'
    JOIN resource_member_quotas q ON q.subpool_period_id = period.id AND q.member_id = m.id
    LEFT JOIN resource_subpool_bindings b ON b.subpool_id = s.id AND b.status = 'active'
    LEFT JOIN codex_oauth_accounts a ON a.id = b.codex_account_id
    WHERE m.user_id = ? AND m.subpool_id = ? AND m.status = 'active'`).get(userId, subpoolId) as Record<string, unknown> | undefined;
  if (!subscription) return null;
  const members = db.prepare(`SELECT m.id, m.user_id userId,
    q.allocation_units allocationUnits, q.used_units usedUnits, q.reserved_units reservedUnits,
    MAX(0, q.allocation_units - q.used_units - q.reserved_units) remainingUnits
    FROM resource_subpool_members m
    LEFT JOIN resource_subpool_quota_periods period ON period.subpool_id = m.subpool_id AND period.status = 'active'
    LEFT JOIN resource_member_quotas q ON q.subpool_period_id = period.id AND q.member_id = m.id
    WHERE m.subpool_id = ? AND m.status IN ('active', 'suspended') ORDER BY m.id`).all(subpoolId) as Array<Record<string, unknown> & { userId: number }>;
  return { subscription, members: members.map((member, index) => ({
    ...member, userId: undefined, label: member.userId === userId ? '我' : `成员 ${index + 1}`, isCurrentUser: member.userId === userId,
  })) };
}

export function getUserResourceUsageAnalytics(db: Db, userId: number) {
  const where = `FROM resource_quota_reservations r
    JOIN resource_member_quotas q ON q.id = r.member_quota_id
    JOIN resource_subpool_members m ON m.id = q.member_id
    LEFT JOIN requests req ON req.id = r.request_id
    WHERE m.user_id = ? AND r.status = 'settled'`;
  const summary = db.prepare(`SELECT COUNT(*) totalRequests,
    COALESCE(SUM(COALESCE(req.input_tokens, 0)), 0) totalInputTokens,
    COALESCE(SUM(COALESCE(r.cached_input_tokens, 0)), 0) totalCachedInputTokens,
    COALESCE(SUM(COALESCE(req.output_tokens, 0)), 0) totalOutputTokens,
    COALESCE(SUM(COALESCE(r.actual_units, r.reserved_units)), 0) consumedQuotaUnits,
    COALESCE(AVG(CASE WHEN req.latency_ms IS NOT NULL THEN req.latency_ms END), 0) avgLatencyMs ${where}`).get(userId);
  const models = db.prepare(`SELECT COALESCE(req.model_id, 'auto') modelId, COUNT(*) requests,
    COALESCE(SUM(COALESCE(req.input_tokens, 0)), 0) inputTokens,
    COALESCE(SUM(COALESCE(r.cached_input_tokens, 0)), 0) cachedInputTokens,
    COALESCE(SUM(COALESCE(req.output_tokens, 0)), 0) outputTokens,
    COALESCE(SUM(COALESCE(r.actual_units, r.reserved_units)), 0) consumedQuotaUnits ${where}
    GROUP BY COALESCE(req.model_id, 'auto') ORDER BY requests DESC, modelId LIMIT 50`).all(userId);
  const timeline = db.prepare(`SELECT date(COALESCE(r.settled_at, r.created_at)) day, COUNT(*) requests,
    COALESCE(SUM(COALESCE(req.input_tokens, 0) + COALESCE(req.output_tokens, 0)), 0) totalTokens ${where}
    AND datetime(COALESCE(r.settled_at, r.created_at)) >= datetime('now', '-30 days')
    GROUP BY date(COALESCE(r.settled_at, r.created_at)) ORDER BY day`).all(userId);
  return { summary, models, timeline, recent: listUserResourceUsage(db, userId, 50) };
}

export function getUserSubscriptionAccountId(db: Db, userId: number, subpoolId: number): number | null {
  const row = db.prepare(`SELECT b.codex_account_id accountId
    FROM resource_subpool_members m
    JOIN resource_subpool_bindings b ON b.subpool_id = m.subpool_id AND b.status = 'active'
    WHERE m.user_id = ? AND m.subpool_id = ? AND m.status = 'active'`).get(userId, subpoolId) as { accountId: number } | undefined;
  return row?.accountId ?? null;
}
