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

export function adminCancelResourceSubpool(db: Db, input: {
  subpoolId: number;
  adminId: number;
}) {
  return db.transaction(() => {
    const pool = db.prepare(`SELECT id, status FROM resource_subpools WHERE id = ?`).get(input.subpoolId) as {
      id: number; status: string;
    } | undefined;
    if (!pool) throw new Error('Resource subpool was not found');
    if (!['waiting_members', 'waiting_resource'].includes(pool.status)) {
      throw new Error('Only a non-activated subpool can be cancelled');
    }

    const orders = db.prepare(`SELECT o.id, o.order_no orderNo, o.user_id userId,
      o.order_status status, o.paid_amount_micro paidAmountMicro
      FROM resource_orders o
      WHERE o.subpool_id = ? ORDER BY o.id`).all(input.subpoolId) as Array<{
        id: number; orderNo: string; userId: number; status: string; paidAmountMicro: number | null;
      }>;
    if (!orders.length || orders.some((order) => !['paid_waiting_group', 'grouped'].includes(order.status))) {
      throw new Error('Subpool contains an order that cannot be refunded');
    }

    const usage = db.prepare(`SELECT 1
      FROM resource_subpool_members m
      LEFT JOIN resource_member_quotas q ON q.member_id = m.id
      LEFT JOIN resource_quota_reservations reservation ON reservation.member_quota_id = q.id
      LEFT JOIN requests request_log ON request_log.consumer_api_key_id = m.consumer_api_key_id
        AND datetime(request_log.created_at) >= datetime(m.joined_at)
      WHERE m.subpool_id = ?
        AND (reservation.id IS NOT NULL OR request_log.id IS NOT NULL)
      LIMIT 1`).get(input.subpoolId);
    if (usage) throw new Error('Resource subpool has usage records and cannot be cancelled');

    let refundedMicro = 0;
    for (const order of orders) {
      const purchase = db.prepare(`SELECT ABS(delta_micro) amount FROM wallet_transactions
        WHERE resource_order_id = ? AND type = 'purchase'`).get(order.id) as { amount: number } | undefined;
      const amount = order.paidAmountMicro ?? purchase?.amount ?? 0;
      if (!purchase || amount <= 0) throw new Error(`Original wallet purchase transaction was not found for order ${order.orderNo}`);
      const wallet = db.prepare(`SELECT balance_micro balanceMicro FROM users WHERE id = ?`).get(order.userId) as {
        balanceMicro: number;
      } | undefined;
      if (!wallet || !Number.isSafeInteger(wallet.balanceMicro + amount)) throw new Error('Wallet refund amount is invalid');
      const balanceAfter = wallet.balanceMicro + amount;
      db.prepare(`UPDATE users SET balance_micro = ? WHERE id = ?`).run(balanceAfter, order.userId);
      db.prepare(`INSERT INTO wallet_transactions
        (user_id, type, delta_micro, balance_after_micro, resource_order_id, note)
        VALUES (?, 'purchase_refund', ?, ?, ?, ?)`).run(
          order.userId, amount, balanceAfter, order.id,
          `Resource purchase refund ${order.orderNo}: administrator cancelled subpool ${input.subpoolId}`,
        );
      const updated = db.prepare(`UPDATE resource_orders SET order_status = 'refunded',
        refund_amount_micro = ?, refund_reason = 'administrator cancelled subpool',
        refund_requested_at = datetime('now'), refunded_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND order_status IN ('paid_waiting_group', 'grouped')`).run(amount, order.id);
      if (updated.changes !== 1) throw new Error('Order state changed during subpool cancellation');
      refundedMicro += amount;
    }

    db.prepare(`DELETE FROM resource_subpool_members WHERE subpool_id = ?`).run(input.subpoolId);
    const expired = db.prepare(`UPDATE resource_subpools
      SET status = 'expired', pending_codex_account_id = NULL, updated_at = datetime('now')
      WHERE id = ? AND status IN ('waiting_members', 'waiting_resource')`).run(input.subpoolId);
    if (expired.changes !== 1) throw new Error('Subpool state changed during cancellation');
    recordResourceAdminAudit(db, {
      adminUserId: input.adminId,
      action: 'resource_subpool_cancelled_and_refunded',
      targetType: 'resource_subpool',
      targetId: input.subpoolId,
      subpoolId: input.subpoolId,
      details: { orderIds: orders.map((order) => order.id), orderCount: orders.length, refundedMicro },
    });
    return { subpoolId: input.subpoolId, orderCount: orders.length, refundedMicro };
  })();
}
