import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { createConsumerApiKey } from '../../services/consumer-api-keys.js';
import { createResourceOrder } from '../../services/resource-orders.js';
import { createResourceProduct, publishResourceProduct } from '../../services/resource-products.js';
import { groupPaidResourceOrder, markResourceOrderPaidForGrouping } from '../../services/resource-grouping.js';
import { reserveSubpoolQuota } from '../../services/resource-quota.js';

describe('resource member Codex key binding', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrationsSync(db, 'up');
  });
  afterEach(() => db.close());

  function product() {
    return publishResourceProduct(db, createResourceProduct(db, {
      productKey: `key-binding-${Math.random()}`, name: 'Key binding', priceMicro: 1_000_000,
      memberLimit: 2, durationValue: 1, durationUnit: 'month', totalQuotaUnits: 1_000_000,
      memberQuotaUnits: 500_000, groupTimeoutMinutes: 1_440,
    }).id);
  }

  function join(userId: number, productId: number) {
    const order = createResourceOrder(db, userId, productId);
    markResourceOrderPaidForGrouping(db, order.id);
    return groupPaidResourceOrder(db, order.id);
  }

  it('binds an existing active Codex key when the order joins a subpool', () => {
    const userId = Number(db.prepare(`INSERT INTO users (email, password_hash) VALUES ('before@example.com', 'x')`).run().lastInsertRowid);
    const key = createConsumerApiKey(db, userId, 'Before purchase', null, 'resource_subpool');
    const grouped = join(userId, product().id);
    const member = db.prepare(`SELECT consumer_api_key_id keyId FROM resource_subpool_members WHERE id = ?`).get(grouped.memberId) as { keyId: number };
    expect(member.keyId).toBe(key.record.id);
  });

  it('binds a newly created Codex key when the user bought first', () => {
    const userId = Number(db.prepare(`INSERT INTO users (email, password_hash) VALUES ('after@example.com', 'x')`).run().lastInsertRowid);
    const grouped = join(userId, product().id);
    expect((db.prepare(`SELECT consumer_api_key_id keyId FROM resource_subpool_members WHERE id = ?`).get(grouped.memberId) as { keyId: number | null }).keyId).toBeNull();

    const key = createConsumerApiKey(db, userId, 'After purchase', null, 'resource_subpool');
    expect((db.prepare(`SELECT consumer_api_key_id keyId FROM resource_subpool_members WHERE id = ?`).get(grouped.memberId) as { keyId: number }).keyId).toBe(key.record.id);
  });

  it('binds multiple keys to one active entitlement and shares its member quota', () => {
    const userId = Number(db.prepare(`INSERT INTO users (email, password_hash) VALUES ('multi@example.com', 'x')`).run().lastInsertRowid);
    const grouped = join(userId, product().id);
    db.prepare(`UPDATE resource_subpools SET status = 'active', starts_at = datetime('now'), ends_at = datetime('now', '+1 month') WHERE id = ?`).run(grouped.subpoolId);
    db.prepare(`UPDATE resource_subpool_members SET status = 'active' WHERE id = ?`).run(grouped.memberId);
    const periodId = Number(db.prepare(`INSERT INTO resource_subpool_quota_periods
      (subpool_id, period_key, allocation_units, starts_at, resets_at)
      VALUES (?, 'multi-period', 1000, datetime('now'), datetime('now', '+1 month'))`).run(grouped.subpoolId).lastInsertRowid);
    const quotaId = Number(db.prepare(`INSERT INTO resource_member_quotas
      (subpool_period_id, member_id, allocation_units) VALUES (?, ?, 500)`).run(periodId, grouped.memberId).lastInsertRowid);

    const first = createConsumerApiKey(db, userId, 'First', null, 'resource_subpool');
    const second = createConsumerApiKey(db, userId, 'Second', null, 'resource_subpool');
    expect(db.prepare(`SELECT consumer_api_key_id keyId FROM resource_member_api_keys
      WHERE member_id = ? ORDER BY consumer_api_key_id`).all(grouped.memberId)).toEqual([
      { keyId: first.record.id }, { keyId: second.record.id },
    ]);

    reserveSubpoolQuota(db, userId, first.record.id, 20);
    reserveSubpoolQuota(db, userId, second.record.id, 30);
    expect(db.prepare(`SELECT reserved_units reserved FROM resource_member_quotas WHERE id = ?`).get(quotaId)).toEqual({ reserved: 50 });
  });

  it('prefers an active entitlement over an older paused entitlement', () => {
    const userId = Number(db.prepare(`INSERT INTO users (email, password_hash) VALUES ('priority@example.com', 'x')`).run().lastInsertRowid);
    const paused = join(userId, product().id);
    db.prepare(`UPDATE resource_subpools SET status = 'paused' WHERE id = ?`).run(paused.subpoolId);
    const active = join(userId, product().id);
    db.prepare(`UPDATE resource_subpools SET status = 'active', starts_at = datetime('now'), ends_at = datetime('now', '+1 month') WHERE id = ?`).run(active.subpoolId);
    db.prepare(`UPDATE resource_subpool_members SET status = 'active' WHERE id = ?`).run(active.memberId);
    const periodId = Number(db.prepare(`INSERT INTO resource_subpool_quota_periods
      (subpool_id, period_key, allocation_units, starts_at, resets_at)
      VALUES (?, 'priority-period', 1000, datetime('now'), datetime('now', '+1 month'))`).run(active.subpoolId).lastInsertRowid);
    db.prepare(`INSERT INTO resource_member_quotas (subpool_period_id, member_id, allocation_units)
      VALUES (?, ?, 500)`).run(periodId, active.memberId);

    const key = createConsumerApiKey(db, userId, 'Active first', null, 'resource_subpool');
    expect(db.prepare(`SELECT member_id memberId FROM resource_member_api_keys WHERE consumer_api_key_id = ?`).get(key.record.id)).toEqual({ memberId: active.memberId });
  });
});
