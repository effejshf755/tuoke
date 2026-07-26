import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { createResourceOrder } from '../../services/resource-orders.js';
import { createResourceProduct, publishResourceProduct } from '../../services/resource-products.js';
import { groupPaidResourceOrder, markResourceOrderPaidForGrouping } from '../../services/resource-grouping.js';
import { activateSubpool, stageSubpoolCodexAccount } from '../../services/resource-subpool-activation.js';
import {
  getPublishedResourceProduct,
  getUserResourceSubscriptionDetail,
  getUserResourceUsageAnalytics,
  listPublishedResourceProducts,
  listUserResourceOrders,
  listUserResourceSubscriptions,
  listUserResourceUsage,
} from '../../services/resource-user.js';

describe('resource user queries', () => {
  let db: Database.Database;
  let adminId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrationsSync(db, 'up');
    adminId = user('resource-admin@example.com', 'admin');
  });
  afterEach(() => db.close());

  function user(email: string, role = 'user'): number {
    return Number(db.prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', ?)`).run(email, role).lastInsertRowid);
  }

  function product(key: string, published = true) {
    const created = createResourceProduct(db, {
      productKey: key, name: `${key} product`, priceMicro: 2_000_000,
      memberLimit: 2, durationValue: 1, durationUnit: 'month',
      totalQuotaUnits: 1_000_000, memberQuotaUnits: 500_000,
      groupTimeoutMinutes: 1_440, refundWindowMinutes: 60,
    });
    return published ? publishResourceProduct(db, created.id) : created;
  }

  function paidOrder(userId: number, productId: number) {
    const order = createResourceOrder(db, userId, productId);
    markResourceOrderPaidForGrouping(db, order.id);
    return groupPaidResourceOrder(db, order.id);
  }

  function activateTwoPersonPool(firstUserId: number, secondUserId: number, productId: number) {
    paidOrder(firstUserId, productId);
    const grouped = paidOrder(secondUserId, productId);
    const accountId = Number(db.prepare(`INSERT INTO codex_oauth_accounts (
      label, access_token_encrypted, access_token_iv, access_token_auth_tag,
      refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag,
      enabled, status, quota_remaining_percent, resource_scope
    ) VALUES ('private-account', 'secret', 'secret', 'secret', 'secret', 'secret', 'secret', 1, 'healthy', 100, 'resource_subpool')`).run().lastInsertRowid);
    stageSubpoolCodexAccount(db, grouped.subpoolId, accountId, adminId);
    activateSubpool(db, grouped.subpoolId, adminId);
    return grouped.subpoolId;
  }

  it('lists only published products and reports the joinable pool progress', () => {
    const visible = product('visible');
    const hidden = product('hidden', false);
    const buyerId = user('waiting@example.com');
    paidOrder(buyerId, visible.id);

    expect(listPublishedResourceProducts(db)).toEqual([
      expect.objectContaining({ id: visible.id, waitingMembers: 1, memberLimit: 2 }),
    ]);
    expect(getPublishedResourceProduct(db, visible.id)).toMatchObject({
      id: visible.id, waitingMembers: 1, refundWindowMinutes: 60,
    });
    expect(getPublishedResourceProduct(db, hidden.id)).toBeNull();
  });

  it('keeps the storefront in the same newest-first order as product management', () => {
    const older = product('older');
    const newer = product('newer');
    db.prepare("UPDATE resource_products SET created_at = '2026-07-25 10:00:00' WHERE id = ?").run(older.id);
    db.prepare("UPDATE resource_products SET created_at = '2026-07-26 10:00:00' WHERE id = ?").run(newer.id);
    expect((listPublishedResourceProducts(db) as any[]).map(row => row.id)).toEqual([newer.id, older.id]);
  });

  it('isolates orders and subscriptions by the authenticated user without account data', () => {
    const item = product('private-data');
    const firstUserId = user('first@example.com');
    const secondUserId = user('second@example.com');
    const subpoolId = activateTwoPersonPool(firstUserId, secondUserId, item.id);

    const firstOrders = listUserResourceOrders(db, firstUserId) as any[];
    const secondOrders = listUserResourceOrders(db, secondUserId) as any[];
    expect(firstOrders).toHaveLength(1);
    expect(secondOrders).toHaveLength(1);
    expect(firstOrders[0].id).not.toBe(secondOrders[0].id);

    const subscriptions = listUserResourceSubscriptions(db, firstUserId) as any[];
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({ subpoolId, totalQuotaUnits: 100_000, usedQuotaUnits: 0 });
    expect(JSON.stringify({ firstOrders, subscriptions })).not.toMatch(/private-account|accountId|oauth|secret/i);
    expect(listUserResourceSubscriptions(db, user('outsider@example.com'))).toEqual([]);
    const detail = getUserResourceSubscriptionDetail(db, firstUserId, subpoolId)!;
    expect(detail.members).toHaveLength(2);
    expect(detail.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'first@example.com', email: 'first@example.com', isCurrentUser: true }),
      expect.objectContaining({ label: 'second@example.com', email: 'second@example.com', isCurrentUser: false }),
    ]));
    expect(JSON.stringify(detail)).not.toMatch(/private-account|accountId|oauth|secret/i);
    expect(getUserResourceSubscriptionDetail(db, user('detail-outsider@example.com'), subpoolId)).toBeNull();
  });

  it('returns only the authenticated user usage and no administrator or OAuth fields', () => {
    const item = product('usage');
    const firstUserId = user('usage-first@example.com');
    const secondUserId = user('usage-second@example.com');
    const subpoolId = activateTwoPersonPool(firstUserId, secondUserId, item.id);
    const members = db.prepare(`SELECT m.id memberId, m.user_id userId, q.id quotaId, q.subpool_period_id periodId
      FROM resource_subpool_members m JOIN resource_member_quotas q ON q.member_id = m.id
      WHERE m.subpool_id = ? ORDER BY m.id`).all(subpoolId) as Array<{ memberId: number; userId: number; quotaId: number; periodId: number }>;

    for (const [index, member] of members.entries()) {
      const requestId = Number(db.prepare(`INSERT INTO requests
        (platform, model_id, key_id, status, input_tokens, output_tokens)
        VALUES ('openai-codex', ?, ?, 'success', 10, 5)`).run(`gpt-user-${index}`, index + 1).lastInsertRowid);
      db.prepare(`INSERT INTO resource_quota_reservations
        (request_correlation_id, subpool_id, period_id, member_quota_id,
         reserved_units, actual_units, request_id, status, expires_at, settled_at)
        VALUES (?, ?, ?, ?, 20, ?, ?, 'settled', datetime('now'), datetime('now'))`)
        .run(`user-usage-${index}`, subpoolId, member.periodId, member.quotaId, 10 + index, requestId);
    }

    const firstUsage = listUserResourceUsage(db, firstUserId) as any[];
    expect(firstUsage).toHaveLength(1);
    expect(firstUsage[0]).toMatchObject({ modelId: 'gpt-user-0', consumedQuotaUnits: 10, inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(JSON.stringify(firstUsage)).not.toMatch(/account|email|admin|oauth/i);
    expect(listUserResourceUsage(db, secondUserId)).toEqual([
      expect.objectContaining({ modelId: 'gpt-user-1', consumedQuotaUnits: 11 }),
    ]);
    const analytics = getUserResourceUsageAnalytics(db, firstUserId) as any;
    expect(analytics.summary).toMatchObject({ totalRequests: 1, totalInputTokens: 10, totalOutputTokens: 5, consumedQuotaUnits: 10 });
    expect(analytics.models).toEqual([expect.objectContaining({ modelId: 'gpt-user-0', requests: 1 })]);
    expect(JSON.stringify(analytics)).not.toMatch(/gpt-user-1|second@example|private-account/i);
  });
});
