import type { Db } from '../db/types.js';
import { recordResourceAdminAudit } from './resource-admin-audit.js';
import { refundResourcePurchase, type ResourceRefundResult } from './resource-purchase.js';

export const ADMIN_RESOURCE_ORDER_STATUSES = [
  'pending_payment', 'paid_waiting_group', 'grouped', 'active', 'refunded',
] as const;

export type AdminResourceOrderStatus = typeof ADMIN_RESOURCE_ORDER_STATUSES[number];

export function listAdminResourceOrders(db: Db, status?: AdminResourceOrderStatus) {
  return db.prepare(`SELECT o.id, o.order_no orderNo, o.order_status status,
    o.user_id userId, u.email userEmail,
    o.product_id productId, o.product_key productKey, o.product_version productVersion,
    o.product_name_snapshot productName, o.price_micro priceMicro,
    o.subpool_id subpoolId, s.status subpoolStatus,
    o.member_limit_snapshot memberLimit,
    COALESCE((SELECT COUNT(*) FROM resource_subpool_members count_member
      WHERE count_member.subpool_id = o.subpool_id), 0) memberCount,
    o.payment_method paymentMethod, o.paid_amount_micro paidAmountMicro,
    o.paid_at paidAt, o.refundable_until refundableUntil,
    o.refund_amount_micro refundAmountMicro, o.refund_reason refundReason,
    o.refund_requested_at refundRequestedAt, o.refunded_at refundedAt,
    o.created_at createdAt, o.updated_at updatedAt
    FROM resource_orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN resource_subpools s ON s.id = o.subpool_id
    WHERE (? IS NULL OR o.order_status = ?)
    ORDER BY o.id DESC`).all(status ?? null, status ?? null);
}

export function getAdminResourceOrderDetail(db: Db, orderId: number) {
  const order = db.prepare(`SELECT o.*, u.email userEmail, u.role userRole,
    u.status userStatus, u.balance_micro userBalanceMicro,
    s.name subpoolName, s.status subpoolStatus, s.member_limit subpoolMemberLimit,
    s.starts_at subpoolStartsAt, s.ends_at subpoolEndsAt,
    s.frozen_total_quota_units frozenTotalQuotaUnits,
    s.frozen_member_quota_units frozenMemberQuotaUnits,
    s.frozen_meter_version frozenMeterVersion
    FROM resource_orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN resource_subpools s ON s.id = o.subpool_id
    WHERE o.id = ?`).get(orderId);
  if (!order) return null;
  const members = db.prepare(`SELECT m.id, m.user_id userId, u.email, m.status,
    m.resource_order_id resourceOrderId, m.consumer_api_key_id consumerApiKeyId,
    q.id memberQuotaId, q.allocation_units allocationUnits,
    q.used_units usedUnits, q.reserved_units reservedUnits, q.status quotaStatus,
    period.id quotaPeriodId, period.status quotaPeriodStatus, period.resets_at quotaResetsAt
    FROM resource_subpool_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN resource_subpool_quota_periods period
      ON period.subpool_id = m.subpool_id AND period.status = 'active'
    LEFT JOIN resource_member_quotas q
      ON q.member_id = m.id AND q.subpool_period_id = period.id
    WHERE m.subpool_id = (SELECT subpool_id FROM resource_orders WHERE id = ?)
    ORDER BY m.id`).all(orderId);
  return { order, members };
}

export function adminRefundResourceOrder(db: Db, input: {
  orderId: number;
  adminId: number;
}): ResourceRefundResult {
  return db.transaction(() => {
    const order = db.prepare(`SELECT id, user_id userId, order_status status,
      paid_at paidAt FROM resource_orders WHERE id = ?`).get(input.orderId) as {
        id: number; userId: number; status: string; paidAt: string | null;
      } | undefined;
    if (!order) throw new Error('Resource order was not found');
    if (order.status === 'refunded') {
      return refundResourcePurchase(db, { userId: order.userId, orderId: order.id });
    }
    if (order.status !== 'paid_waiting_group') {
      throw new Error('Only a paid_waiting_group order can be refunded');
    }
    const usage = db.prepare(`SELECT 1
      FROM resource_subpool_members m
      LEFT JOIN resource_member_quotas q ON q.member_id = m.id
      LEFT JOIN resource_quota_reservations reservation ON reservation.member_quota_id = q.id
      LEFT JOIN requests request_log ON request_log.consumer_api_key_id = m.consumer_api_key_id
        AND datetime(request_log.created_at) >= datetime(COALESCE(?, m.joined_at))
      WHERE m.resource_order_id = ?
        AND (reservation.id IS NOT NULL OR request_log.id IS NOT NULL)
      LIMIT 1`).get(order.paidAt, order.id);
    if (usage) throw new Error('Resource order has usage records and cannot be refunded');

    const result = refundResourcePurchase(db, { userId: order.userId, orderId: order.id });
    if (!result.alreadyProcessed) {
      recordResourceAdminAudit(db, {
        adminUserId: input.adminId,
        action: 'resource_order_refunded',
        targetType: 'resource_order',
        targetId: order.id,
        details: { userId: order.userId, refundedMicro: result.refundedMicro },
      });
    }
    return result;
  })();
}
