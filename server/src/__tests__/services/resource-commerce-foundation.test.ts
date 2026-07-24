import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { down as downCommerce, up as upCommerce } from '../../db/migrations/20260725_000031_resource_products_orders.js';
import { down as downGrouping, up as upGrouping } from '../../db/migrations/20260725_000032_resource_grouping_status.js';
import {
  createNextResourceProductVersion,
  createResourceProduct,
  publishResourceProduct,
} from '../../services/resource-products.js';
import {
  createResourceOrder,
  linkResourceOrderToSubpoolMember,
} from '../../services/resource-orders.js';

describe('resource commerce foundation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrationsSync(db, 'up');
  });

  afterEach(() => db.close());

  function createProduct() {
    return createResourceProduct(db, {
      productKey: 'codex-pro20-monthly',
      name: 'Codex Pro20 four-person group',
      priceMicro: 29_900_000,
      memberLimit: 4,
      durationValue: 1,
      durationUnit: 'month',
      totalQuotaUnits: 1_000_000,
      memberQuotaUnits: 250_000,
      groupTimeoutMinutes: 7 * 24 * 60,
      refundWindowMinutes: 60,
    });
  }

  it('creates the commerce tables and subpool provenance columns', () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('resource_products', 'resource_orders') ORDER BY name`).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(['resource_orders', 'resource_products']);
    const subpoolColumns = db.prepare(`PRAGMA table_info(resource_subpools)`).all() as Array<{ name: string }>;
    const memberColumns = db.prepare(`PRAGMA table_info(resource_subpool_members)`).all() as Array<{ name: string }>;
    expect(subpoolColumns.some((column) => column.name === 'product_id')).toBe(true);
    expect(memberColumns.some((column) => column.name === 'resource_order_id')).toBe(true);
  });

  it('round-trips the independent commerce migration', () => {
    downGrouping(db);
    downCommerce(db);
    const absent = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('resource_products', 'resource_orders')`).all();
    expect(absent).toEqual([]);
    expect((db.prepare(`PRAGMA table_info(resource_subpools)`).all() as Array<{ name: string }>).some((column) => column.name === 'product_id')).toBe(false);
    upCommerce(db);
    upGrouping(db);
    expect((db.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type = 'table' AND name IN ('resource_products', 'resource_orders')`).get() as { count: number }).count).toBe(2);
  });

  it('freezes order values and creates later product changes as a new version', () => {
    const userId = Number(db.prepare(`INSERT INTO users (email, password_hash) VALUES ('buyer@example.com', 'x')`).run().lastInsertRowid);
    const first = publishResourceProduct(db, createProduct().id);
    const order = createResourceOrder(db, userId, first.id);
    const second = createNextResourceProductVersion(db, first.id, { priceMicro: 39_900_000, name: 'Codex Pro20 revised' });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.status).toBe('draft');
    expect(order.productVersion).toBe(1);
    expect(order.productName).toBe(first.name);
    expect(order.priceMicro).toBe(29_900_000);
  });

  it('links one paid order to its dedicated subpool member exactly once', () => {
    const userId = Number(db.prepare(`INSERT INTO users (email, password_hash) VALUES ('member@example.com', 'x')`).run().lastInsertRowid);
    const product = publishResourceProduct(db, createProduct().id);
    const order = createResourceOrder(db, userId, product.id);
    db.prepare(`UPDATE resource_orders SET order_status = 'paid_waiting_group' WHERE id = ?`).run(order.id);
    const subpoolId = Number(db.prepare(`INSERT INTO resource_subpools (name, mode, status, member_limit) VALUES ('waiting pool', 'dedicated', 'waiting_members', 4)`).run().lastInsertRowid);
    const memberId = Number(db.prepare(`INSERT INTO resource_subpool_members (subpool_id, user_id, status) VALUES (?, ?, 'waiting')`).run(subpoolId, userId).lastInsertRowid);

    const linked = linkResourceOrderToSubpoolMember(db, { orderId: order.id, subpoolId, memberId });
    expect(linked.subpoolId).toBe(subpoolId);
    expect((db.prepare(`SELECT product_id productId FROM resource_subpools WHERE id = ?`).get(subpoolId) as any).productId).toBe(product.id);
    expect((db.prepare(`SELECT resource_order_id orderId FROM resource_subpool_members WHERE id = ?`).get(memberId) as any).orderId).toBe(order.id);
    expect(() => linkResourceOrderToSubpoolMember(db, { orderId: order.id, subpoolId, memberId })).toThrow(/already assigned/);
  });

  it('rejects a quota allocation that exceeds the product total', () => {
    expect(() => createResourceProduct(db, {
      productKey: 'invalid', name: 'Invalid allocation', priceMicro: 1,
      memberLimit: 4, durationValue: 1, durationUnit: 'month',
      totalQuotaUnits: 99, memberQuotaUnits: 25, groupTimeoutMinutes: 60,
    })).toThrow();
  });
});
