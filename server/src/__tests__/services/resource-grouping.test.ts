import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { createResourceOrder } from '../../services/resource-orders.js';
import { createResourceProduct, publishResourceProduct } from '../../services/resource-products.js';
import { groupPaidResourceOrder, markResourceOrderPaidForGrouping } from '../../services/resource-grouping.js';

describe('resource order grouping', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrationsSync(db, 'up');
  });

  afterEach(() => db.close());

  function product(key: string, name = key) {
    return publishResourceProduct(db, createResourceProduct(db, {
      productKey: key,
      name,
      priceMicro: 10_000_000,
      memberLimit: 4,
      durationValue: 1,
      durationUnit: 'month',
      totalQuotaUnits: 100,
      memberQuotaUnits: 25,
      groupTimeoutMinutes: 10_080,
    }).id);
  }

  function paidOrder(productId: number, index: number) {
    const userId = Number(db.prepare(`INSERT INTO users (email, password_hash) VALUES (?, 'x')`).run(`buyer-${productId}-${index}@example.com`).lastInsertRowid);
    const order = createResourceOrder(db, userId, productId);
    markResourceOrderPaidForGrouping(db, order.id);
    return order.id;
  }

  it('keeps the first three members waiting and forms the four-person pool with the fourth', () => {
    const item = product('four-person');
    const firstThree = [1, 2, 3].map((index) => groupPaidResourceOrder(db, paidOrder(item.id, index)));
    expect(new Set(firstThree.map((result) => result.subpoolId)).size).toBe(1);
    expect(firstThree.map((result) => result.memberCount)).toEqual([1, 2, 3]);
    expect(firstThree.every((result) => !result.formed && result.subpoolStatus === 'waiting_members')).toBe(true);

    const fourth = groupPaidResourceOrder(db, paidOrder(item.id, 4));
    expect(fourth.subpoolId).toBe(firstThree[0].subpoolId);
    expect(fourth.memberCount).toBe(4);
    expect(fourth.formed).toBe(true);
    expect(fourth.subpoolStatus).toBe('waiting_resource');
    const statuses = db.prepare(`SELECT DISTINCT order_status status FROM resource_orders WHERE subpool_id = ?`).all(fourth.subpoolId) as Array<{ status: string }>;
    expect(statuses).toEqual([{ status: 'grouped' }]);
    expect(db.prepare(`SELECT frozen_total_quota_units totalQuota,
      frozen_member_quota_units memberQuota, frozen_meter_version meterVersion,
      frozen_at frozenAt FROM resource_subpools WHERE id = ?`).get(fourth.subpoolId)).toMatchObject({
      totalQuota: 100,
      memberQuota: 25,
      meterVersion: 'tokens-v1',
      frozenAt: expect.any(String),
    });
  });

  it('creates a new waiting pool for the fifth paid order', () => {
    const item = product('overflow');
    const results = [1, 2, 3, 4, 5].map((index) => groupPaidResourceOrder(db, paidOrder(item.id, index)));
    expect(results[3].formed).toBe(true);
    expect(results[4].subpoolId).not.toBe(results[3].subpoolId);
    expect(results[4].memberCount).toBe(1);
    expect(results[4].subpoolStatus).toBe('waiting_members');
  });

  it('does not allow the same order to join twice', () => {
    const item = product('duplicate');
    const orderId = paidOrder(item.id, 1);
    groupPaidResourceOrder(db, orderId);
    expect(() => groupPaidResourceOrder(db, orderId)).toThrow(/already assigned/);
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_members WHERE resource_order_id = ?`).get(orderId) as { count: number }).count).toBe(1);
  });

  it('never mixes different product versions into one pool', () => {
    const first = product('product-a');
    const second = product('product-b');
    const firstResult = groupPaidResourceOrder(db, paidOrder(first.id, 1));
    const secondResult = groupPaidResourceOrder(db, paidOrder(second.id, 1));
    expect(firstResult.subpoolId).not.toBe(secondResult.subpoolId);
    const pools = db.prepare(`SELECT id, product_id productId FROM resource_subpools ORDER BY id`).all() as Array<{ id: number; productId: number }>;
    expect(pools).toEqual([
      { id: firstResult.subpoolId, productId: first.id },
      { id: secondResult.subpoolId, productId: second.id },
    ]);
  });
});
