import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { createConsumerApiKey } from '../../services/consumer-api-keys.js';
import { createResourceOrder } from '../../services/resource-orders.js';
import { createResourceProduct, publishResourceProduct } from '../../services/resource-products.js';
import { groupPaidResourceOrder, markResourceOrderPaidForGrouping } from '../../services/resource-grouping.js';

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
});
