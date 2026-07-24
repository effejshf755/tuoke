import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { createResourceProduct, publishResourceProduct } from '../../services/resource-products.js';
import {
  purchaseResourceProduct,
  refundResourcePurchase,
  ResourcePurchaseError,
} from '../../services/resource-purchase.js';

describe('resource wallet purchase', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrationsSync(db, 'up');
  });

  afterEach(() => db.close());

  function createUser(email: string, balanceMicro: number, reservedMicro = 0): number {
    return Number(db.prepare(`INSERT INTO users
      (email, password_hash, balance_micro, reserved_balance_micro)
      VALUES (?, 'x', ?, ?)`).run(email, balanceMicro, reservedMicro).lastInsertRowid);
  }

  function createProduct(key: string, priceMicro = 10_000_000) {
    return publishResourceProduct(db, createResourceProduct(db, {
      productKey: key,
      name: key,
      priceMicro,
      memberLimit: 4,
      durationValue: 1,
      durationUnit: 'month',
      totalQuotaUnits: 1_000_000,
      memberQuotaUnits: 250_000,
      groupTimeoutMinutes: 10_080,
    }).id);
  }

  function balance(userId: number): number {
    return (db.prepare('SELECT balance_micro value FROM users WHERE id = ?').get(userId) as { value: number }).value;
  }

  it('rolls back the order and wallet changes when available balance is insufficient', () => {
    const product = createProduct('insufficient');
    const userId = createUser('insufficient@example.com', 12_000_000, 3_000_001);

    expect(() => purchaseResourceProduct(db, {
      userId,
      productId: product.id,
      idempotencyKey: 'insufficient-1',
    })).toThrowError(ResourcePurchaseError);

    expect(balance(userId)).toBe(12_000_000);
    expect((db.prepare('SELECT COUNT(*) count FROM resource_orders').get() as { count: number }).count).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) count FROM wallet_transactions
      WHERE type IN ('purchase', 'purchase_refund')`).get() as { count: number }).count).toBe(0);
  });

  it('deducts the wallet, records the purchase, and enters grouping atomically', () => {
    const product = createProduct('success');
    const userId = createUser('success@example.com', 30_000_000);

    const result = purchaseResourceProduct(db, {
      userId,
      productId: product.id,
      idempotencyKey: 'success-1',
    });

    expect(result.alreadyProcessed).toBe(false);
    expect(result.chargedMicro).toBe(10_000_000);
    expect(result.balanceAfterMicro).toBe(20_000_000);
    expect(result.order.orderStatus).toBe('paid_waiting_group');
    expect(result.grouping.memberCount).toBe(1);
    expect(result.grouping.subpoolStatus).toBe('waiting_members');
    expect(balance(userId)).toBe(20_000_000);

    const transaction = db.prepare(`SELECT type, delta_micro deltaMicro,
      balance_after_micro balanceAfterMicro, resource_order_id resourceOrderId
      FROM wallet_transactions WHERE type = 'purchase'`).get() as {
        type: string; deltaMicro: number; balanceAfterMicro: number; resourceOrderId: number;
      };
    expect(transaction).toEqual({
      type: 'purchase',
      deltaMicro: -10_000_000,
      balanceAfterMicro: 20_000_000,
      resourceOrderId: result.order.id,
    });
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_members
      WHERE resource_order_id = ?`).get(result.order.id) as { count: number }).count).toBe(1);
  });

  it('returns the existing result without charging twice for the same idempotency key', () => {
    const product = createProduct('idempotent');
    const userId = createUser('idempotent@example.com', 30_000_000);
    const input = { userId, productId: product.id, idempotencyKey: 'same-purchase' };

    const first = purchaseResourceProduct(db, input);
    const second = purchaseResourceProduct(db, input);

    expect(second.alreadyProcessed).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    expect(balance(userId)).toBe(20_000_000);
    expect((db.prepare(`SELECT COUNT(*) count FROM wallet_transactions
      WHERE resource_order_id = ? AND type = 'purchase'`).get(first.order.id) as { count: number }).count).toBe(1);
  });

  it('refunds a waiting order within 60 minutes and restores its pool slot', () => {
    const product = createProduct('refund');
    const userId = createUser('refund@example.com', 30_000_000);
    const purchase = purchaseResourceProduct(db, {
      userId,
      productId: product.id,
      idempotencyKey: 'refund-1',
    });

    const refund = refundResourcePurchase(db, { userId, orderId: purchase.order.id });

    expect(refund.alreadyProcessed).toBe(false);
    expect(refund.refundedMicro).toBe(10_000_000);
    expect(refund.balanceAfterMicro).toBe(30_000_000);
    expect(refund.order.orderStatus).toBe('refunded');
    expect(balance(userId)).toBe(30_000_000);
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_members
      WHERE resource_order_id = ?`).get(purchase.order.id) as { count: number }).count).toBe(0);

    const refundTransaction = db.prepare(`SELECT delta_micro deltaMicro,
      balance_after_micro balanceAfterMicro FROM wallet_transactions
      WHERE resource_order_id = ? AND type = 'purchase_refund'`).get(purchase.order.id) as {
        deltaMicro: number; balanceAfterMicro: number;
      };
    expect(refundTransaction).toEqual({ deltaMicro: 10_000_000, balanceAfterMicro: 30_000_000 });

    const duplicate = refundResourcePurchase(db, { userId, orderId: purchase.order.id });
    expect(duplicate.alreadyProcessed).toBe(true);
    expect(balance(userId)).toBe(30_000_000);
    expect((db.prepare(`SELECT COUNT(*) count FROM wallet_transactions
      WHERE resource_order_id = ? AND type = 'purchase_refund'`).get(purchase.order.id) as { count: number }).count).toBe(1);
  });
});
