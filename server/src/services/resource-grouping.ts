import type { Db } from '../db/types.js';
import { getResourceOrder, type ResourceOrderRow } from './resource-orders.js';
import { bindAvailableCodexPoolKey } from './resource-member-key.js';

export interface ResourceGroupingResult {
  order: ResourceOrderRow;
  subpoolId: number;
  memberId: number;
  memberCount: number;
  memberLimit: number;
  formed: boolean;
  subpoolStatus: 'waiting_members' | 'waiting_resource';
}

/** Payment adapters call this after their own settlement succeeds. */
export function markResourceOrderPaidForGrouping(db: Db, orderId: number): ResourceOrderRow {
  const updated = db.prepare(`UPDATE resource_orders
    SET order_status = 'paid_waiting_group', paid_at = COALESCE(paid_at, datetime('now')),
        paid_amount_micro = COALESCE(paid_amount_micro, price_micro),
        refundable_until = datetime(COALESCE(paid_at, datetime('now')), '+' || refund_window_minutes_snapshot || ' minutes'),
        updated_at = datetime('now')
    WHERE id = ? AND order_status = 'pending_payment' AND subpool_id IS NULL`).run(orderId);
  if (updated.changes !== 1) throw new Error('Order is not eligible to enter paid grouping');
  return getResourceOrder(db, orderId)!;
}

export function groupPaidResourceOrder(db: Db, orderId: number): ResourceGroupingResult {
  return db.transaction(() => {
    const order = db.prepare(`SELECT id, user_id userId, product_id productId,
      product_name_snapshot productName, member_limit_snapshot memberLimit,
      order_status orderStatus, subpool_id subpoolId
      FROM resource_orders WHERE id = ?`).get(orderId) as {
        id: number; userId: number; productId: number; productName: string;
        memberLimit: number; orderStatus: string; subpoolId: number | null;
      } | undefined;
    if (!order) throw new Error('Resource order was not found');
    if (order.orderStatus !== 'paid_waiting_group') throw new Error('Order is not waiting for grouping');
    if (order.subpoolId !== null) throw new Error('Order is already assigned to a subpool');

    let pool = db.prepare(`SELECT s.id
      FROM resource_subpools s
      WHERE s.product_id = ? AND s.mode = 'dedicated' AND s.status = 'waiting_members'
        AND (SELECT COUNT(*) FROM resource_subpool_members m WHERE m.subpool_id = s.id) < s.member_limit
      ORDER BY s.id ASC LIMIT 1`).get(order.productId) as { id: number } | undefined;

    if (!pool) {
      const inserted = db.prepare(`INSERT INTO resource_subpools
        (name, product_id, mode, status, member_limit)
        VALUES (?, ?, 'dedicated', 'waiting_members', ?)`).run(
          `${order.productName} #${order.id}`,
          order.productId,
          order.memberLimit,
        );
      pool = { id: Number(inserted.lastInsertRowid) };
    }

    const memberInsert = db.prepare(`INSERT INTO resource_subpool_members
      (subpool_id, user_id, resource_order_id, status)
      VALUES (?, ?, ?, 'waiting')`).run(pool.id, order.userId, order.id);
    const memberId = Number(memberInsert.lastInsertRowid);
    bindAvailableCodexPoolKey(db, memberId, order.userId);
    const linked = db.prepare(`UPDATE resource_orders SET subpool_id = ?, updated_at = datetime('now')
      WHERE id = ? AND subpool_id IS NULL AND order_status = 'paid_waiting_group'`).run(pool.id, order.id);
    if (linked.changes !== 1) throw new Error('Order assignment changed during grouping');

    const memberCount = (db.prepare(`SELECT COUNT(*) count FROM resource_subpool_members WHERE subpool_id = ?`).get(pool.id) as { count: number }).count;
    if (memberCount > order.memberLimit) throw new Error('Subpool member limit exceeded');
    const formed = memberCount === order.memberLimit;
    if (formed) {
      const entitlement = db.prepare(`SELECT COUNT(*) memberCount,
        MIN(o.total_quota_units_snapshot) minTotal, MAX(o.total_quota_units_snapshot) maxTotal,
        MIN(o.member_quota_units_snapshot) minMember, MAX(o.member_quota_units_snapshot) maxMember,
        MIN(o.meter_version_snapshot) minMeter, MAX(o.meter_version_snapshot) maxMeter
        FROM resource_subpool_members m
        JOIN resource_orders o ON o.id = m.resource_order_id
        WHERE m.subpool_id = ?`).get(pool.id) as {
          memberCount: number; minTotal: number; maxTotal: number;
          minMember: number; maxMember: number; minMeter: string; maxMeter: string;
        };
      if (entitlement.memberCount !== order.memberLimit
        || entitlement.minTotal !== entitlement.maxTotal
        || entitlement.minMember !== entitlement.maxMember
        || entitlement.minMeter !== entitlement.maxMeter) {
        throw new Error('Subpool order entitlement snapshots are inconsistent');
      }
      const formedPool = db.prepare(`UPDATE resource_subpools
        SET status = 'waiting_resource',
            frozen_total_quota_units = ?, frozen_member_quota_units = ?,
            frozen_meter_version = ?, frozen_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND status = 'waiting_members' AND frozen_at IS NULL`).run(
        entitlement.minTotal, entitlement.minMember, entitlement.minMeter, pool.id,
      );
      if (formedPool.changes !== 1) throw new Error('Subpool state changed during grouping');
      db.prepare(`UPDATE resource_orders SET order_status = 'grouped', updated_at = datetime('now')
        WHERE subpool_id = ? AND order_status = 'paid_waiting_group'`).run(pool.id);
    }

    const subpoolStatus: ResourceGroupingResult['subpoolStatus'] = formed
      ? 'waiting_resource'
      : 'waiting_members';

    return {
      order: getResourceOrder(db, order.id)!,
      subpoolId: pool.id,
      memberId,
      memberCount,
      memberLimit: order.memberLimit,
      formed,
      subpoolStatus,
    };
  })();
}

export function processPaidResourceOrder(db: Db, orderId: number): ResourceGroupingResult {
  return db.transaction(() => {
    markResourceOrderPaidForGrouping(db, orderId);
    return groupPaidResourceOrder(db, orderId);
  })();
}
