import { EventEmitter } from 'events';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { clientContextMiddleware } from '../../lib/client-context.js';
import { logRequest } from '../../lib/request-log.js';
import { consumerQuota } from '../../middleware/consumerQuota.js';
import { createConsumerApiKey } from '../../services/consumer-api-keys.js';
import { createResourceProduct, publishResourceProduct } from '../../services/resource-products.js';
import { purchaseResourceProduct, refundResourcePurchase } from '../../services/resource-purchase.js';
import { activateSubpool, stageSubpoolCodexAccount } from '../../services/resource-subpool-activation.js';
import { pauseResourceSubpool, resumeResourceSubpool } from '../../services/resource-subpool-operations.js';

class TestResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  headers = new Map<string, string>();

  status(code: number) { this.statusCode = code; return this; }
  json(body: unknown) { this.body = body; return this; }
  setHeader(name: string, value: string) { this.headers.set(name, value); }
}

describe('resource marketplace end-to-end flow', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '7'.repeat(64);
    initDb(':memory:');
  });

  it('covers purchase, grouping, activation, quota settlement, refund, pause, and resume', () => {
    const db = getDb();
    const adminId = Number(db.prepare(`INSERT INTO users (email, password_hash, role)
      VALUES ('resource-e2e-admin@example.com', 'x', 'admin')`).run().lastInsertRowid);
    const users = ['A', 'B', 'C', 'D'].map((name) => {
      const userId = Number(db.prepare(`INSERT INTO users (email, password_hash, balance_micro)
        VALUES (?, 'x', 110000000)`).run(`resource-e2e-${name.toLowerCase()}@example.com`).lastInsertRowid);
      const apiKey = createConsumerApiKey(db, userId, `Codex ${name}`, null, 'resource_subpool');
      return { name, userId, apiKey };
    });

    const product = publishResourceProduct(db, createResourceProduct(db, {
      productKey: 'resource-e2e-four-person',
      name: 'Codex four-person plan',
      priceMicro: 10_000_000,
      memberLimit: 4,
      durationValue: 1,
      durationUnit: 'month',
      totalQuotaUnits: 1_000_000,
      memberQuotaUnits: 250_000,
      groupTimeoutMinutes: 10_080,
    }).id);

    const purchases = users.map((user, index) => purchaseResourceProduct(db, {
      userId: user.userId,
      productId: product.id,
      idempotencyKey: `resource-e2e-purchase-${index + 1}`,
    }));
    const subpoolId = purchases[0].grouping.subpoolId;

    expect(purchases.slice(0, 3).map((purchase) => purchase.grouping.formed)).toEqual([false, false, false]);
    expect(purchases[3].grouping).toMatchObject({
      subpoolId,
      memberCount: 4,
      memberLimit: 4,
      formed: true,
      subpoolStatus: 'waiting_resource',
    });
    expect(new Set(purchases.map((purchase) => purchase.grouping.subpoolId))).toEqual(new Set([subpoolId]));
    expect(db.prepare(`SELECT order_status status, COUNT(*) count FROM resource_orders
      WHERE subpool_id = ? GROUP BY order_status`).all(subpoolId)).toEqual([{ status: 'grouped', count: 4 }]);

    const model = db.prepare(`SELECT model_id modelId FROM model_billing_rules
      WHERE platform = 'openai-codex' AND billing_enabled = 1 LIMIT 1`).get() as { modelId: string };
    expect(model?.modelId).toBeTruthy();
    const accountId = Number(db.prepare(`INSERT INTO codex_oauth_accounts (
      label, access_token_encrypted, access_token_iv, access_token_auth_tag,
      refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag,
      enabled, status, quota_remaining_percent, quota_reset_at, resource_scope
    ) VALUES ('resource-e2e-account', 'x', 'x', 'x', 'x', 'x', 'x',
      1, 'healthy', 100, datetime('now', '+30 days'), 'resource_subpool')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO codex_oauth_account_models (account_id, model_id, enabled)
      VALUES (?, ?, 1)`).run(accountId, model.modelId);

    stageSubpoolCodexAccount(db, subpoolId, accountId, adminId);
    const activation = activateSubpool(db, subpoolId, adminId);
    expect(activation).toMatchObject({ subpoolId, accountId, allocationUnits: 1_000_000, status: 'active' });
    expect(activation.memberAllocations).toHaveLength(4);
    expect(activation.memberAllocations.every((quota) => quota.allocationUnits === 250_000)).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_members
      WHERE subpool_id = ? AND status = 'active' AND consumer_api_key_id IS NOT NULL`).get(subpoolId) as { count: number }).count).toBe(4);

    const caller = users[0];
    const walletBeforeCall = (db.prepare(`SELECT balance_micro balance FROM users WHERE id = ?`)
      .get(caller.userId) as { balance: number }).balance;
    expect(walletBeforeCall).toBe(100_000_000);
    const request = {
      method: 'POST',
      path: '/chat/completions',
      headers: { authorization: `Bearer ${caller.apiKey.key}` },
      body: { model: model.modelId, messages: [{ role: 'user', content: 'hello Codex' }], max_tokens: 100 },
      socket: { remoteAddress: '127.0.0.1' },
    } as any;
    const response = new TestResponse() as any;
    let requestId: number | undefined;
    clientContextMiddleware(request, response, () => consumerQuota(request, response, () => {
      requestId = logRequest('openai-codex', model.modelId, -accountId, 'success', 12, 8, 25, null);
    }));

    expect(response.statusCode).toBe(200);
    expect(requestId).toEqual(expect.any(Number));
    expect(db.prepare(`SELECT status, input_tokens inputTokens, output_tokens outputTokens,
      consumer_user_id consumerUserId, consumer_api_key_id consumerApiKeyId,
      billing_status billingStatus, billing_amount_micro billingAmountMicro
      FROM requests WHERE id = ?`).get(requestId)).toEqual({
      status: 'success', inputTokens: 12, outputTokens: 8,
      consumerUserId: caller.userId, consumerApiKeyId: caller.apiKey.record.id,
      billingStatus: 'exempt', billingAmountMicro: 0,
    });
    const memberQuota = db.prepare(`SELECT q.used_units usedUnits, q.reserved_units reservedUnits
      FROM resource_member_quotas q
      JOIN resource_subpool_members m ON m.id = q.member_id
      WHERE m.subpool_id = ? AND m.user_id = ?`).get(subpoolId, caller.userId);
    expect(memberQuota).toEqual({ usedUnits: 20, reservedUnits: 0 });
    expect(db.prepare(`SELECT used_units usedUnits, reserved_units reservedUnits
      FROM resource_subpool_quota_periods WHERE id = ?`).get(activation.quotaPeriodId))
      .toEqual({ usedUnits: 20, reservedUnits: 0 });
    expect(db.prepare(`SELECT status, actual_units actualUnits, request_id requestId
      FROM resource_quota_reservations WHERE subpool_id = ?`).get(subpoolId))
      .toEqual({ status: 'settled', actualUnits: 20, requestId });
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_quota_ledger
      WHERE subpool_id = ? AND request_id = ? AND type = 'settlement'`).get(subpoolId, requestId) as { count: number }).count).toBe(1);
    expect((db.prepare(`SELECT balance_micro balance FROM users WHERE id = ?`)
      .get(caller.userId) as { balance: number }).balance).toBe(walletBeforeCall);
    expect((db.prepare(`SELECT COUNT(*) count FROM wallet_reservations
      WHERE user_id = ?`).get(caller.userId) as { count: number }).count).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) count FROM wallet_transactions
      WHERE user_id = ? AND type = 'usage'`).get(caller.userId) as { count: number }).count).toBe(0);

    const waitingPurchase = purchaseResourceProduct(db, {
      userId: caller.userId,
      productId: product.id,
      idempotencyKey: 'resource-e2e-refundable-purchase',
    });
    expect(waitingPurchase.grouping).toMatchObject({ memberCount: 1, formed: false, subpoolStatus: 'waiting_members' });
    const balanceAfterWaitingPurchase = (db.prepare(`SELECT balance_micro balance FROM users WHERE id = ?`)
      .get(caller.userId) as { balance: number }).balance;
    const refund = refundResourcePurchase(db, { userId: caller.userId, orderId: waitingPurchase.order.id });
    expect(refund.order.orderStatus).toBe('refunded');
    expect(refund.balanceAfterMicro).toBe(balanceAfterWaitingPurchase + product.priceMicro);
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_members
      WHERE resource_order_id = ?`).get(waitingPurchase.order.id) as { count: number }).count).toBe(0);

    pauseResourceSubpool(db, subpoolId, adminId);
    const pausedResponse = new TestResponse() as any;
    let continuedWhilePaused = false;
    clientContextMiddleware(request, pausedResponse, () => consumerQuota(request, pausedResponse, () => {
      continuedWhilePaused = true;
    }));
    expect(continuedWhilePaused).toBe(false);
    expect(pausedResponse.statusCode).toBe(403);
    expect(pausedResponse.body).toMatchObject({ error: { type: 'resource_subpool_inactive' } });

    resumeResourceSubpool(db, subpoolId, adminId);
    const resumedResponse = new TestResponse() as any;
    let continuedAfterResume = false;
    let resumedRequestId: number | undefined;
    clientContextMiddleware(request, resumedResponse, () => consumerQuota(request, resumedResponse, () => {
      continuedAfterResume = true;
      resumedRequestId = logRequest('openai-codex', model.modelId, -accountId, 'success', 5, 5, 20, null);
    }));
    expect(continuedAfterResume).toBe(true);
    expect(resumedResponse.statusCode).toBe(200);
    expect(db.prepare(`SELECT status FROM requests WHERE id = ?`).get(resumedRequestId)).toEqual({ status: 'success' });
    expect(db.prepare(`SELECT used_units usedUnits, reserved_units reservedUnits
      FROM resource_subpool_quota_periods WHERE id = ?`).get(activation.quotaPeriodId))
      .toEqual({ usedUnits: 30, reservedUnits: 0 });
  });
});
