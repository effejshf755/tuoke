import { EventEmitter } from 'events';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { clientContextMiddleware } from '../../lib/client-context.js';
import { consumerQuota } from '../../middleware/consumerQuota.js';
import { createConsumerApiKey } from '../../services/consumer-api-keys.js';
import { routePinnedModel } from '../../services/router.js';

class TestResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  headers = new Map<string, string>();
  status(code: number) { this.statusCode = code; return this; }
  json(body: unknown) { this.body = body; return this; }
  setHeader(name: string, value: string) { this.headers.set(name, value); }
}

describe('Codex resource consumer quota', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '1'.repeat(64);
    initDb(':memory:');
  });

  it('reserves only resource quota and never requires or reserves wallet balance', () => {
    const db = getDb();
    const userId = Number(db.prepare(`INSERT INTO users
      (email, password_hash, balance_micro) VALUES ('quota-only@example.com', 'x', 0)`).run().lastInsertRowid);
    const createdKey = createConsumerApiKey(db, userId, 'Subscription key', null, 'resource_subpool');
    const model = db.prepare(`SELECT m.id modelDbId, m.model_id modelId FROM models m
      JOIN model_billing_rules b ON b.platform = m.platform AND b.model_id = m.model_id
      WHERE m.platform = 'openai-codex' AND b.billing_enabled = 1 LIMIT 1`).get() as { modelDbId: number; modelId: string };
    const accountId = Number(db.prepare(`INSERT INTO codex_oauth_accounts (
      label, access_token_encrypted, access_token_iv, access_token_auth_tag,
      refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag, enabled, status, resource_scope
    ) VALUES ('quota-only', 'x', 'x', 'x', 'x', 'x', 'x', 1, 'healthy', 'resource_subpool')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO codex_oauth_account_models (account_id, model_id, enabled)
      VALUES (?, ?, 1)`).run(accountId, model.modelId);

    const subpoolId = Number(db.prepare(`INSERT INTO resource_subpools
      (name, mode, status, member_limit, starts_at, ends_at)
      VALUES ('quota-only', 'dedicated', 'active', 1, datetime('now'), datetime('now', '+1 month'))`).run().lastInsertRowid);
    const memberId = Number(db.prepare(`INSERT INTO resource_subpool_members
      (subpool_id, user_id, consumer_api_key_id, status, activated_at)
      VALUES (?, ?, ?, 'active', datetime('now'))`).run(subpoolId, userId, createdKey.record.id).lastInsertRowid);
    const periodId = Number(db.prepare(`INSERT INTO resource_subpool_quota_periods
      (subpool_id, period_key, allocation_units, starts_at, resets_at)
      VALUES (?, 'quota-only-period', 100000, datetime('now'), datetime('now', '+1 month'))`).run(subpoolId).lastInsertRowid);
    db.prepare(`INSERT INTO resource_member_quotas
      (subpool_period_id, member_id, allocation_units) VALUES (?, ?, 100000)`).run(periodId, memberId);
    db.prepare(`INSERT INTO resource_subpool_bindings (subpool_id, codex_account_id, status)
      VALUES (?, ?, 'active')`).run(subpoolId, accountId);

    const req = {
      method: 'POST', path: '/chat/completions',
      headers: { authorization: `Bearer ${createdKey.key}` },
      body: { model: model.modelId, messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 },
      socket: { remoteAddress: '127.0.0.1' },
    } as any;
    const res = new TestResponse() as any;
    let continued = false;
    let routedKeyId: number | null = null;
    clientContextMiddleware(req, res, () => consumerQuota(req, res, () => {
      continued = true;
      routedKeyId = routePinnedModel(model.modelDbId, 1)?.keyId ?? null;
    }));

    expect(continued).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(routedKeyId).toBe(-accountId);
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_quota_reservations
      WHERE subpool_id = ? AND status = 'reserved'`).get(subpoolId) as { count: number }).count).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) count FROM wallet_reservations WHERE user_id = ?`).get(userId) as { count: number }).count).toBe(0);
    expect((db.prepare(`SELECT balance_micro balance FROM users WHERE id = ?`).get(userId) as { balance: number }).balance).toBe(0);
  });

  it('enforces all three key scopes and keeps ordinary Codex and resource accounts separate', () => {
    const db = getDb();
    const model = db.prepare(`SELECT id modelDbId, model_id modelId FROM models
      WHERE platform = 'openai-codex' LIMIT 1`).get() as { modelDbId: number; modelId: string };
    const ordinaryModel = db.prepare(`SELECT m.model_id modelId FROM models m
      JOIN model_billing_rules b ON b.platform = m.platform AND b.model_id = m.model_id
      WHERE m.platform <> 'openai-codex' AND b.billing_enabled = 1 LIMIT 1`).get() as { modelId: string };
    const userId = Number(db.prepare(`INSERT INTO users (email, password_hash, balance_micro)
      VALUES ('scope-matrix@example.com', 'x', 100000000)`).run().lastInsertRowid);
    const universal = createConsumerApiKey(db, userId, 'Universal', null, 'universal');
    const codex = createConsumerApiKey(db, userId, 'Codex pool', null, 'codex_pool');
    const resource = createConsumerApiKey(db, userId, 'Codex resource', null, 'resource_subpool');

    const callGate = (key: string, requestedModel: string, onNext?: () => void) => {
      const req = { method: 'POST', path: '/chat/completions', headers: { authorization: `Bearer ${key}` },
        body: { model: requestedModel, messages: [{ role: 'user', content: 'hello' }], max_tokens: 1 },
        socket: { remoteAddress: '127.0.0.1' } } as any;
      const res = new TestResponse() as any;
      let continued = false;
      clientContextMiddleware(req, res, () => consumerQuota(req, res, () => { continued = true; onNext?.(); }));
      return { continued, res };
    };

    expect(callGate(universal.key, model.modelId).res.statusCode).toBe(403);
    expect(callGate(codex.key, ordinaryModel.modelId).res.statusCode).toBe(403);
    expect(callGate(resource.key, ordinaryModel.modelId).res.statusCode).toBe(403);
    expect(callGate(universal.key, ordinaryModel.modelId).continued).toBe(true);

    const sharedAccountId = Number(db.prepare(`INSERT INTO codex_oauth_accounts (
      label, access_token_encrypted, access_token_iv, access_token_auth_tag,
      refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag, enabled, status, resource_scope
    ) VALUES ('shared-only', 'x', 'x', 'x', 'x', 'x', 'x', 1, 'healthy', 'codex_pool')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO codex_oauth_account_models (account_id, model_id, enabled) VALUES (?, ?, 1)`)
      .run(sharedAccountId, model.modelId);
    let sharedRouteKeyId: number | null = null;
    expect(callGate(codex.key, model.modelId, () => {
      sharedRouteKeyId = routePinnedModel(model.modelDbId, 1)?.keyId ?? null;
    }).continued).toBe(true);
    expect(sharedRouteKeyId).toBe(-sharedAccountId);

    // A resource key without a matching active entitlement cannot fall back to
    // either the shared Codex account or wallet billing.
    const deniedResource = callGate(resource.key, model.modelId);
    expect(deniedResource.continued).toBe(false);
    expect(deniedResource.res.statusCode).toBe(403);
  });
});
