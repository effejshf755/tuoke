import { randomUUID } from 'crypto';
import type { Db } from '../db/types.js';

export interface ResourceOrderRow {
  id: number;
  orderNo: string;
  userId: number;
  productId: number;
  subpoolId: number | null;
  productKey: string;
  productVersion: number;
  productName: string;
  priceMicro: number;
  memberLimit: number;
  durationValue: number;
  durationUnit: 'day' | 'month';
  totalQuotaUnits: number;
  memberQuotaUnits: number;
  orderStatus: string;
  refundableUntil: string | null;
}

const orderSelect = `SELECT id, order_no orderNo, user_id userId, product_id productId,
  subpool_id subpoolId, product_key productKey, product_version productVersion,
  product_name_snapshot productName, price_micro priceMicro,
  member_limit_snapshot memberLimit, duration_value_snapshot durationValue,
  duration_unit_snapshot durationUnit, total_quota_units_snapshot totalQuotaUnits,
  member_quota_units_snapshot memberQuotaUnits, order_status orderStatus,
  refundable_until refundableUntil FROM resource_orders`;

export function getResourceOrder(db: Db, orderId: number): ResourceOrderRow | null {
  return db.prepare(`${orderSelect} WHERE id = ?`).get(orderId) as ResourceOrderRow | undefined ?? null;
}

export function createResourceOrder(db: Db, userId: number, productId: number): ResourceOrderRow {
  return db.transaction(() => {
    const product = db.prepare(`SELECT * FROM resource_products WHERE id = ? AND status = 'published'
      AND (sale_starts_at IS NULL OR datetime(sale_starts_at) <= datetime('now'))
      AND (sale_ends_at IS NULL OR datetime(sale_ends_at) > datetime('now'))`).get(productId) as any;
    if (!product) throw new Error('Published product is not available for sale');
    const orderNo = `RP${Date.now()}${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
    const inserted = db.prepare(`INSERT INTO resource_orders (
      order_no, user_id, product_id, product_key, product_version,
      product_name_snapshot, price_micro, member_limit_snapshot,
      duration_value_snapshot, duration_unit_snapshot, quota_allocation_type_snapshot,
      total_quota_units_snapshot, member_quota_units_snapshot, meter_version_snapshot,
      group_timeout_minutes_snapshot, refund_window_minutes_snapshot,
      payment_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+30 minutes'))`).run(
      orderNo, userId, product.id, product.product_key, product.version, product.name,
      product.price_micro, product.member_limit, product.duration_value, product.duration_unit,
      product.quota_allocation_type, product.total_quota_units, product.member_quota_units,
      product.meter_version, product.group_timeout_minutes, product.refund_window_minutes,
    );
    return getResourceOrder(db, Number(inserted.lastInsertRowid))!;
  })();
}

export function linkResourceOrderToSubpoolMember(db: Db, input: {
  orderId: number;
  subpoolId: number;
  memberId: number;
}): ResourceOrderRow {
  return db.transaction(() => {
    const row = db.prepare(`SELECT o.id orderId, o.user_id userId, o.product_id productId,
      o.order_status orderStatus, o.subpool_id orderSubpoolId,
      s.product_id subpoolProductId, s.mode subpoolMode,
      m.user_id memberUserId, m.subpool_id memberSubpoolId, m.resource_order_id memberOrderId
      FROM resource_orders o
      JOIN resource_subpools s ON s.id = ?
      JOIN resource_subpool_members m ON m.id = ?
      WHERE o.id = ?`).get(input.subpoolId, input.memberId, input.orderId) as any;
    if (!row) throw new Error('Order, subpool, or member was not found');
    if (!['paid_waiting_group', 'grouped'].includes(row.orderStatus)) throw new Error('Order is not eligible for subpool assignment');
    if (row.subpoolMode !== 'dedicated') throw new Error('V1 orders only support dedicated subpools');
    if (row.memberUserId !== row.userId || row.memberSubpoolId !== input.subpoolId) throw new Error('Member does not belong to the order user and subpool');
    if (row.orderSubpoolId !== null || row.memberOrderId !== null) throw new Error('Order or member is already assigned');
    if (row.subpoolProductId !== null && row.subpoolProductId !== row.productId) throw new Error('Subpool belongs to a different product version');
    db.prepare(`UPDATE resource_subpools SET product_id = COALESCE(product_id, ?), updated_at = datetime('now') WHERE id = ?`).run(row.productId, input.subpoolId);
    db.prepare(`UPDATE resource_orders SET subpool_id = ?, updated_at = datetime('now') WHERE id = ? AND subpool_id IS NULL`).run(input.subpoolId, input.orderId);
    db.prepare(`UPDATE resource_subpool_members SET resource_order_id = ? WHERE id = ? AND resource_order_id IS NULL`).run(input.orderId, input.memberId);
    return getResourceOrder(db, input.orderId)!;
  })();
}
