import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { createConsumerApiKey } from '../../services/consumer-api-keys.js';
import { purchaseResourceProduct } from '../../services/resource-purchase.js';
import { createResourceProduct, publishResourceProduct } from '../../services/resource-products.js';
import {
  expireEndedResourceSubpools,
  refundTimedOutResourceGroups,
  releaseExpiredResourceReservations,
  resetDueResourceQuotaPeriods,
} from '../../services/resource-maintenance.js';
import { reserveSubpoolQuota } from '../../services/resource-quota.js';
import { activateSubpool, stageSubpoolCodexAccount } from '../../services/resource-subpool-activation.js';

describe('resource maintenance', () => {
  let db: Database.Database;
  let adminId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrationsSync(db, 'up');
    adminId = Number(db.prepare(`INSERT INTO users (email, password_hash, role)
      VALUES ('maintenance-admin@example.com', 'x', 'admin')`).run().lastInsertRowid);
  });

  afterEach(() => db.close());

  function createProduct(key: string, memberLimit = 2, groupTimeoutMinutes = 60) {
    return publishResourceProduct(db, createResourceProduct(db, {
      productKey: key,
      name: `Maintenance ${key}`,
      priceMicro: 10_000_000,
      memberLimit,
      durationValue: 1,
      durationUnit: 'month',
      totalQuotaUnits: 1_000_000,
      memberQuotaUnits: Math.floor(1_000_000 / memberLimit),
      groupTimeoutMinutes,
    }).id);
  }

  function createUser(email: string, balanceMicro = 20_000_000): number {
    return Number(db.prepare(`INSERT INTO users (email, password_hash, balance_micro)
      VALUES (?, 'x', ?)`).run(email, balanceMicro).lastInsertRowid);
  }

  function createActivePool(key: string) {
    const product = createProduct(key);
    const users = [createUser(`${key}-1@example.com`), createUser(`${key}-2@example.com`)];
    let subpoolId = 0;
    const keyIds: number[] = [];
    for (const [index, userId] of users.entries()) {
      keyIds.push(createConsumerApiKey(db, userId, `Codex ${index}`, null, 'resource_subpool').record.id);
      subpoolId = purchaseResourceProduct(db, {
        userId,
        productId: product.id,
        idempotencyKey: `${key}-${index}`,
      }).grouping.subpoolId;
    }
    const accountId = Number(db.prepare(`INSERT INTO codex_oauth_accounts (
      label, access_token_encrypted, access_token_iv, access_token_auth_tag,
      refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag,
      enabled, status, quota_remaining_percent, quota_reset_at, resource_scope
    ) VALUES (?, 'x', 'x', 'x', 'x', 'x', 'x', 1, 'healthy', 100, datetime('now', '+30 days'), 'resource_subpool')`).run(key).lastInsertRowid);
    stageSubpoolCodexAccount(db, subpoolId, accountId);
    const activation = activateSubpool(db, subpoolId, adminId);
    return { subpoolId, accountId, productId: product.id, users, keyIds, periodId: activation.quotaPeriodId };
  }

  it('releases expired quota reservations idempotently', () => {
    const seeded = createActivePool('reservation-expiry');
    const reservation = reserveSubpoolQuota(db, seeded.users[0], seeded.keyIds[0], 10_000);
    db.prepare(`UPDATE resource_quota_reservations SET expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(reservation.reservationId);

    expect(releaseExpiredResourceReservations(db)).toBe(1);
    expect(releaseExpiredResourceReservations(db)).toBe(0);
    expect(db.prepare(`SELECT status FROM resource_quota_reservations WHERE id = ?`).get(reservation.reservationId)).toEqual({ status: 'failed' });
    expect(db.prepare(`SELECT reserved_units reserved FROM resource_subpool_quota_periods WHERE id = ?`).get(seeded.periodId)).toEqual({ reserved: 0 });
  });

  it('refunds wallet purchases whose waiting group deadline elapsed', () => {
    const product = createProduct('group-timeout', 2, 1);
    const userId = createUser('group-timeout@example.com');
    const purchase = purchaseResourceProduct(db, { userId, productId: product.id, idempotencyKey: 'group-timeout' });
    db.prepare(`UPDATE resource_orders SET paid_at = datetime('now', '-2 minutes') WHERE id = ?`).run(purchase.order.id);

    expect(refundTimedOutResourceGroups(db)).toBe(1);
    expect(db.prepare(`SELECT order_status status, refund_reason reason FROM resource_orders WHERE id = ?`).get(purchase.order.id))
      .toEqual({ status: 'refunded', reason: 'group timeout refund' });
    expect(db.prepare(`SELECT balance_micro balance FROM users WHERE id = ?`).get(userId)).toEqual({ balance: 20_000_000 });
    expect(db.prepare(`SELECT status FROM resource_subpools WHERE id = ?`).get(purchase.grouping.subpoolId)).toEqual({ status: 'expired' });
    expect(refundTimedOutResourceGroups(db)).toBe(0);
  });

  it('creates a fresh product-backed quota period after the official reset', () => {
    const seeded = createActivePool('quota-reset');
    db.prepare(`UPDATE resource_products
      SET total_quota_units = 800000, member_quota_units = 400000, meter_version = 'changed-v2'
      WHERE id = ?`).run(seeded.productId);
    db.prepare(`UPDATE resource_subpool_quota_periods SET resets_at = datetime('now', '-1 minute') WHERE id = ?`).run(seeded.periodId);
    db.prepare(`UPDATE codex_oauth_accounts SET quota_reset_at = datetime('now', '+30 days'), quota_remaining_percent = 100 WHERE id = ?`).run(seeded.accountId);

    expect(resetDueResourceQuotaPeriods(db)).toBe(1);
    expect(db.prepare(`SELECT status FROM resource_subpool_quota_periods WHERE id = ?`).get(seeded.periodId)).toEqual({ status: 'closed' });
    const active = db.prepare(`SELECT id, allocation_units allocation, meter_version meterVersion FROM resource_subpool_quota_periods
      WHERE subpool_id = ? AND status = 'active'`).get(seeded.subpoolId) as { id: number; allocation: number };
    expect(active.allocation).toBe(1_000_000);
    expect(active).toMatchObject({ meterVersion: 'tokens-v1' });
    expect(db.prepare(`SELECT allocation_units allocation FROM resource_member_quotas
      WHERE subpool_period_id = ? ORDER BY id LIMIT 1`).get(active.id)).toEqual({ allocation: 500_000 });
    expect(resetDueResourceQuotaPeriods(db)).toBe(0);
  });

  it('expires ended subpools and closes their entitlements and account binding', () => {
    const seeded = createActivePool('pool-expiry');
    db.prepare(`UPDATE resource_subpools SET ends_at = datetime('now', '-1 minute') WHERE id = ?`).run(seeded.subpoolId);

    expect(expireEndedResourceSubpools(db)).toBe(1);
    expect(db.prepare(`SELECT status FROM resource_subpools WHERE id = ?`).get(seeded.subpoolId)).toEqual({ status: 'expired' });
    expect(db.prepare(`SELECT status FROM resource_subpool_bindings WHERE subpool_id = ?`).get(seeded.subpoolId)).toEqual({ status: 'released' });
    expect(db.prepare(`SELECT COUNT(*) count FROM resource_subpool_members WHERE subpool_id = ? AND status = 'expired'`).get(seeded.subpoolId)).toEqual({ count: 2 });
    expect(db.prepare(`SELECT COUNT(*) count FROM resource_orders WHERE subpool_id = ? AND order_status = 'completed'`).get(seeded.subpoolId)).toEqual({ count: 2 });
    expect(expireEndedResourceSubpools(db)).toBe(0);
  });
});
