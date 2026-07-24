import type { Db } from '../db/types.js';
import { createResourceOrder, getResourceOrder, type ResourceOrderRow } from './resource-orders.js';
import { processPaidResourceOrder, type ResourceGroupingResult } from './resource-grouping.js';

export type ResourcePurchaseErrorCode =
  | 'insufficient_balance'
  | 'invalid_idempotency_key'
  | 'purchase_conflict'
  | 'refund_not_allowed';

export class ResourcePurchaseError extends Error {
  constructor(public readonly code: ResourcePurchaseErrorCode, message: string) {
    super(message);
  }
}

export interface ResourcePurchaseResult {
  order: ResourceOrderRow;
  grouping: ResourceGroupingResult;
  chargedMicro: number;
  balanceAfterMicro: number;
  alreadyProcessed: boolean;
}

export interface ResourceRefundResult {
  order: ResourceOrderRow;
  refundedMicro: number;
  balanceAfterMicro: number;
  alreadyProcessed: boolean;
}

export function purchaseResourceProduct(db: Db, input: {
  userId: number;
  productId: number;
  idempotencyKey: string;
}): ResourcePurchaseResult {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new ResourcePurchaseError('invalid_idempotency_key', 'A purchase idempotency key is required');
  }

  return db.transaction(() => {
    const existing = db.prepare(`SELECT id, user_id userId, product_id productId,
      price_micro priceMicro, subpool_id subpoolId
      FROM resource_orders WHERE purchase_idempotency_key = ?`).get(idempotencyKey) as {
        id: number; userId: number; productId: number; priceMicro: number; subpoolId: number | null;
      } | undefined;
    if (existing) {
      if (existing.userId !== input.userId || existing.productId !== input.productId) {
        throw new ResourcePurchaseError('purchase_conflict', 'Idempotency key belongs to a different purchase');
      }
      const wallet = db.prepare(`SELECT balance_micro balanceMicro FROM users WHERE id = ?`).get(input.userId) as { balanceMicro: number } | undefined;
      const order = getResourceOrder(db, existing.id)!;
      const member = db.prepare(`SELECT id FROM resource_subpool_members WHERE resource_order_id = ?`).get(existing.id) as { id: number } | undefined;
      if (!wallet || !order || existing.subpoolId === null || !member) {
        throw new ResourcePurchaseError('purchase_conflict', 'Existing purchase is incomplete');
      }
      const memberCount = (db.prepare(`SELECT COUNT(*) count FROM resource_subpool_members WHERE subpool_id = ?`).get(existing.subpoolId) as { count: number }).count;
      const pool = db.prepare(`SELECT member_limit memberLimit, status FROM resource_subpools WHERE id = ?`).get(existing.subpoolId) as { memberLimit: number; status: string };
      if (pool.status !== 'waiting_members' && pool.status !== 'waiting_resource') {
        throw new ResourcePurchaseError('purchase_conflict', 'Existing purchase has an invalid subpool state');
      }
      const subpoolStatus: ResourceGroupingResult['subpoolStatus'] = pool.status;
      return {
        order,
        grouping: {
          order, subpoolId: existing.subpoolId, memberId: member.id,
          memberCount, memberLimit: pool.memberLimit,
          formed: subpoolStatus === 'waiting_resource',
          subpoolStatus,
        },
        chargedMicro: existing.priceMicro,
        balanceAfterMicro: wallet.balanceMicro,
        alreadyProcessed: true,
      };
    }

    const order = createResourceOrder(db, input.userId, input.productId);
    db.prepare(`UPDATE resource_orders SET purchase_idempotency_key = ? WHERE id = ?`).run(idempotencyKey, order.id);
    const wallet = db.prepare(`SELECT balance_micro balanceMicro,
      reserved_balance_micro reservedMicro FROM users WHERE id = ? AND status = 'active'`).get(input.userId) as {
        balanceMicro: number; reservedMicro: number;
      } | undefined;
    const availableMicro = wallet ? wallet.balanceMicro - wallet.reservedMicro : 0;
    if (!wallet || availableMicro < order.priceMicro) {
      throw new ResourcePurchaseError('insufficient_balance', 'Insufficient wallet balance for resource purchase');
    }
    const balanceAfterMicro = wallet.balanceMicro - order.priceMicro;
    const deducted = db.prepare(`UPDATE users SET balance_micro = balance_micro - ?
      WHERE id = ? AND balance_micro - reserved_balance_micro >= ?`).run(order.priceMicro, input.userId, order.priceMicro);
    if (deducted.changes !== 1) {
      throw new ResourcePurchaseError('insufficient_balance', 'Insufficient wallet balance for resource purchase');
    }
    db.prepare(`INSERT INTO wallet_transactions
      (user_id, type, delta_micro, balance_after_micro, resource_order_id, note)
      VALUES (?, 'purchase', ?, ?, ?, ?)`).run(
        input.userId, -order.priceMicro, balanceAfterMicro, order.id,
        `Resource purchase ${order.orderNo}`,
      );
    const grouping = processPaidResourceOrder(db, order.id);
    return {
      order: grouping.order,
      grouping,
      chargedMicro: order.priceMicro,
      balanceAfterMicro,
      alreadyProcessed: false,
    };
  })();
}

export function refundResourcePurchase(db: Db, input: {
  userId: number;
  orderId: number;
}): ResourceRefundResult {
  return refundWaitingResourceOrder(db, {
    ...input,
    reason: 'wallet purchase refund',
    requireUserWindow: true,
  });
}

export function refundTimedOutResourcePurchase(db: Db, orderId: number): ResourceRefundResult {
  const order = db.prepare(`SELECT user_id userId FROM resource_orders WHERE id = ?
    AND order_status = 'paid_waiting_group' AND paid_at IS NOT NULL
    AND datetime(paid_at, '+' || group_timeout_minutes_snapshot || ' minutes') <= datetime('now')`).get(orderId) as {
      userId: number;
    } | undefined;
  if (!order) throw new ResourcePurchaseError('refund_not_allowed', 'Resource order has not timed out');
  return refundWaitingResourceOrder(db, {
    userId: order.userId,
    orderId,
    reason: 'group timeout refund',
    requireUserWindow: false,
  });
}

function refundWaitingResourceOrder(db: Db, input: {
  userId: number;
  orderId: number;
  reason: string;
  requireUserWindow: boolean;
}): ResourceRefundResult {
  return db.transaction(() => {
    const order = db.prepare(`SELECT id, order_no orderNo, user_id userId,
      order_status orderStatus, subpool_id subpoolId, paid_amount_micro paidAmountMicro,
      refundable_until refundableUntil
      FROM resource_orders WHERE id = ?`).get(input.orderId) as {
        id: number; orderNo: string; userId: number; orderStatus: string;
        subpoolId: number | null; paidAmountMicro: number | null; refundableUntil: string | null;
      } | undefined;
    if (!order || order.userId !== input.userId) {
      throw new ResourcePurchaseError('refund_not_allowed', 'Resource order was not found');
    }
    const wallet = db.prepare(`SELECT balance_micro balanceMicro FROM users WHERE id = ?`).get(input.userId) as { balanceMicro: number } | undefined;
    if (!wallet) throw new ResourcePurchaseError('refund_not_allowed', 'Wallet was not found');
    if (order.orderStatus === 'refunded') {
      const refunded = db.prepare(`SELECT ABS(delta_micro) amount FROM wallet_transactions
        WHERE resource_order_id = ? AND type = 'purchase_refund'`).get(order.id) as { amount: number } | undefined;
      return { order: getResourceOrder(db, order.id)!, refundedMicro: refunded?.amount ?? 0, balanceAfterMicro: wallet.balanceMicro, alreadyProcessed: true };
    }
    if (order.orderStatus !== 'paid_waiting_group' || order.subpoolId === null
      || (input.requireUserWindow && (order.refundableUntil === null
        || !db.prepare(`SELECT 1 WHERE datetime(?) >= datetime('now')`).get(order.refundableUntil)))) {
      throw new ResourcePurchaseError('refund_not_allowed', 'Order is not refundable or the refund window has expired');
    }
    const purchase = db.prepare(`SELECT ABS(delta_micro) amount FROM wallet_transactions
      WHERE resource_order_id = ? AND type = 'purchase'`).get(order.id) as { amount: number } | undefined;
    const refundMicro = order.paidAmountMicro ?? purchase?.amount ?? 0;
    if (!purchase || refundMicro <= 0 || !Number.isSafeInteger(wallet.balanceMicro + refundMicro)) {
      throw new ResourcePurchaseError('refund_not_allowed', 'Original wallet purchase transaction was not found');
    }
    const pool = db.prepare(`SELECT status FROM resource_subpools WHERE id = ?`).get(order.subpoolId) as { status: string } | undefined;
    if (!pool || pool.status !== 'waiting_members') {
      throw new ResourcePurchaseError('refund_not_allowed', 'A formed or active subpool cannot be refunded');
    }
    const removed = db.prepare(`DELETE FROM resource_subpool_members
      WHERE subpool_id = ? AND resource_order_id = ? AND user_id = ?`).run(order.subpoolId, order.id, input.userId);
    if (removed.changes !== 1) throw new ResourcePurchaseError('refund_not_allowed', 'Order membership was not found');

    const balanceAfterMicro = wallet.balanceMicro + refundMicro;
    db.prepare(`UPDATE users SET balance_micro = ? WHERE id = ?`).run(balanceAfterMicro, input.userId);
    db.prepare(`INSERT INTO wallet_transactions
      (user_id, type, delta_micro, balance_after_micro, resource_order_id, note)
      VALUES (?, 'purchase_refund', ?, ?, ?, ?)`).run(
        input.userId, refundMicro, balanceAfterMicro, order.id,
        `Resource purchase refund ${order.orderNo}: ${input.reason}`,
      );
    const updated = db.prepare(`UPDATE resource_orders SET order_status = 'refunded',
      refund_amount_micro = ?, refund_reason = ?,
      refund_requested_at = datetime('now'), refunded_at = datetime('now'),
      updated_at = datetime('now')
      WHERE id = ? AND order_status = 'paid_waiting_group'`).run(refundMicro, input.reason, order.id);
    if (updated.changes !== 1) throw new ResourcePurchaseError('refund_not_allowed', 'Order state changed during refund');
    return { order: getResourceOrder(db, order.id)!, refundedMicro: refundMicro, balanceAfterMicro, alreadyProcessed: false };
  })();
}
