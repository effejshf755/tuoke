import type { Express } from 'express';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { createConsumerApiKey } from '../../services/consumer-api-keys.js';
import { createResourceProduct, publishResourceProduct } from '../../services/resource-products.js';
import { purchaseResourceProduct } from '../../services/resource-purchase.js';
import { activateSubpool, stageSubpoolCodexAccount } from '../../services/resource-subpool-activation.js';

async function call(app: Express, method: string, path: string, body: unknown, token: string) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    server.close();
  }
}

describe('admin resource order operations', () => {
  let app: Express;
  let adminId: number;
  let adminToken: string;
  let sequence = 0;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '2'.repeat(64);
    initDb(':memory:');
    app = createApp();
    const admin = createUser('order-admin@example.com', 'supersecret');
    adminId = admin.userId;
    adminToken = createSession(admin.userId);
  });

  function user(label: string, balanceMicro = 20_000_000): number {
    sequence += 1;
    const created = createUser(`${label}-${sequence}@example.com`, 'supersecret');
    getDb().prepare(`UPDATE users SET balance_micro = ? WHERE id = ?`).run(balanceMicro, created.userId);
    return created.userId;
  }

  function product(label: string) {
    sequence += 1;
    return publishResourceProduct(getDb(), createResourceProduct(getDb(), {
      productKey: `${label}-${sequence}`,
      name: label,
      priceMicro: 10_000_000,
      memberLimit: 2,
      durationValue: 1,
      durationUnit: 'month',
      totalQuotaUnits: 1_000_000,
      memberQuotaUnits: 500_000,
      groupTimeoutMinutes: 10_080,
    }).id);
  }

  it('refunds a waiting order to the wallet and exposes it in admin queries', async () => {
    const userId = user('refund-success');
    const purchase = purchaseResourceProduct(getDb(), {
      userId,
      productId: product('Refund success').id,
      idempotencyKey: 'admin-refund-success',
    });

    const list = await call(app, 'GET', '/api/admin/resources/orders?status=paid_waiting_group', undefined, adminToken);
    expect(list.status).toBe(200);
    expect(list.body.orders.some((order: any) => order.id === purchase.order.id)).toBe(true);
    const detail = await call(app, 'GET', `/api/admin/resources/orders/${purchase.order.id}`, undefined, adminToken);
    expect(detail.status).toBe(200);
    expect(detail.body.order).toMatchObject({ id: purchase.order.id, user_id: userId, order_status: 'paid_waiting_group' });
    expect(detail.body.members).toHaveLength(1);

    const refund = await call(app, 'POST', `/api/admin/resources/orders/${purchase.order.id}/refund`, {}, adminToken);
    expect(refund.status).toBe(200);
    expect(refund.body).toMatchObject({ refundedMicro: 10_000_000, balanceAfterMicro: 20_000_000, alreadyProcessed: false });
    expect(getDb().prepare(`SELECT balance_micro balance FROM users WHERE id = ?`).get(userId)).toEqual({ balance: 20_000_000 });
    expect(getDb().prepare(`SELECT COUNT(*) count FROM wallet_transactions
      WHERE resource_order_id = ? AND type = 'purchase_refund'`).get(purchase.order.id)).toEqual({ count: 1 });
    expect(getDb().prepare(`SELECT COUNT(*) count FROM resource_subpool_members
      WHERE resource_order_id = ?`).get(purchase.order.id)).toEqual({ count: 0 });
  });

  it('returns an idempotent result without crediting the wallet twice', async () => {
    const refunded = getDb().prepare(`SELECT id, user_id userId FROM resource_orders
      WHERE order_status = 'refunded' ORDER BY id DESC LIMIT 1`).get() as { id: number; userId: number };
    const before = getDb().prepare(`SELECT balance_micro balance FROM users WHERE id = ?`).get(refunded.userId);
    const repeat = await call(app, 'POST', `/api/admin/resources/orders/${refunded.id}/refund`, {}, adminToken);
    expect(repeat.status).toBe(200);
    expect(repeat.body.alreadyProcessed).toBe(true);
    expect(getDb().prepare(`SELECT balance_micro balance FROM users WHERE id = ?`).get(refunded.userId)).toEqual(before);
    expect(getDb().prepare(`SELECT COUNT(*) count FROM wallet_transactions
      WHERE resource_order_id = ? AND type = 'purchase_refund'`).get(refunded.id)).toEqual({ count: 1 });
  });

  it('rejects refunding an activated order', async () => {
    const item = product('Active order');
    const users = [user('active-one'), user('active-two')];
    let subpoolId = 0;
    let firstOrderId = 0;
    for (const [index, userId] of users.entries()) {
      createConsumerApiKey(getDb(), userId, `Active Codex ${index}`, null, 'resource_subpool');
      const purchase = purchaseResourceProduct(getDb(), {
        userId, productId: item.id, idempotencyKey: `active-order-${index}`,
      });
      subpoolId = purchase.grouping.subpoolId;
      if (index === 0) firstOrderId = purchase.order.id;
    }
    const accountId = Number(getDb().prepare(`INSERT INTO codex_oauth_accounts (
      label, access_token_encrypted, access_token_iv, access_token_auth_tag,
      refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag,
      enabled, status, quota_remaining_percent, quota_reset_at, resource_scope
    ) VALUES ('active-refund-account', 'x', 'x', 'x', 'x', 'x', 'x', 1, 'healthy', 100, datetime('now', '+30 days'), 'resource_subpool')`).run().lastInsertRowid);
    stageSubpoolCodexAccount(getDb(), subpoolId, accountId);
    activateSubpool(getDb(), subpoolId, adminId);

    const refund = await call(app, 'POST', `/api/admin/resources/orders/${firstOrderId}/refund`, {}, adminToken);
    expect(refund.status).toBe(409);
    expect(refund.body.error.message).toMatch(/paid_waiting_group/);
    expect(getDb().prepare(`SELECT order_status status FROM resource_orders WHERE id = ?`).get(firstOrderId)).toEqual({ status: 'active' });
  });

  it('rejects a waiting order that already produced a request record', async () => {
    const userId = user('used-order');
    const key = createConsumerApiKey(getDb(), userId, 'Used Codex key', null, 'resource_subpool');
    const purchase = purchaseResourceProduct(getDb(), {
      userId,
      productId: product('Used order').id,
      idempotencyKey: 'used-order',
    });
    getDb().prepare(`INSERT INTO requests
      (platform, model_id, key_id, status, input_tokens, output_tokens, consumer_user_id, consumer_api_key_id)
      VALUES ('openai-codex', 'gpt-test', -1, 'success', 10, 5, ?, ?)`).run(userId, key.record.id);

    const refund = await call(app, 'POST', `/api/admin/resources/orders/${purchase.order.id}/refund`, {}, adminToken);
    expect(refund.status).toBe(409);
    expect(refund.body.error.message).toMatch(/usage records/);
    expect(getDb().prepare(`SELECT order_status status FROM resource_orders WHERE id = ?`).get(purchase.order.id)).toEqual({ status: 'paid_waiting_group' });
    expect(getDb().prepare(`SELECT balance_micro balance FROM users WHERE id = ?`).get(userId)).toEqual({ balance: 10_000_000 });
  });
});
