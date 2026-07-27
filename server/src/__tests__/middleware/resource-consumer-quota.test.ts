import { EventEmitter } from 'events';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { clientContextMiddleware, setConsumerIdentity } from '../../lib/client-context.js';
import { consumerQuota } from '../../middleware/consumerQuota.js';
import { createConsumerApiKey } from '../../services/consumer-api-keys.js';
import { PAID_MODEL_MINIMUM_BALANCE_MICRO } from '../../services/free-model-access.js';
import { resolveModelGroupCandidates, routePinnedModel, routeRequest } from '../../services/router.js';

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

  it('requires the estimated maximum PAYG cost to be available', () => {
    const db = getDb();
    const model = { modelId: 'payg-fixed-reservation-test' };
    db.prepare(`INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, monthly_token_budget, enabled, supports_tools
    ) VALUES ('groq', ?, ?, 50, 50, '', '', 1, 1)`).run(model.modelId, model.modelId);
    db.prepare(`INSERT INTO model_billing_rules
      (platform, model_id, input_price_micro_per_million, output_price_micro_per_million,
       multiplier_milli, billing_enabled)
      VALUES ('groq', ?, 1000000, 1000000, 1000, 1)`).run(model.modelId);

    const callGate = (email: string, balanceMicro: number) => {
      const userId = Number(db.prepare(`INSERT INTO users (email, password_hash, balance_micro)
        VALUES (?, 'x', ?)`).run(email, balanceMicro).lastInsertRowid);
      const key = createConsumerApiKey(db, userId, 'PAYG threshold', null, 'universal');
      const req = {
        method: 'POST', path: '/chat/completions',
        headers: { authorization: `Bearer ${key.key}` },
        body: {
          model: model.modelId,
          messages: [{ role: 'user', content: 'x'.repeat(500_000) }],
          max_tokens: 100_000,
        },
        socket: { remoteAddress: '127.0.0.1' },
      } as any;
      const res = new TestResponse() as any;
      let continued = false;
      clientContextMiddleware(req, res, () => consumerQuota(req, res, () => { continued = true; }));
      return { continued, res, userId };
    };

    const below = callGate('payg-below-threshold@example.com', PAID_MODEL_MINIMUM_BALANCE_MICRO - 1);
    expect(below.continued).toBe(false);
    expect(below.res.statusCode).toBe(402);
    expect((below.res.body as any).error.minimum_balance_micro).toBe(100_000);

    const atThreshold = callGate('payg-at-threshold@example.com', PAID_MODEL_MINIMUM_BALANCE_MICRO);
    expect(atThreshold.continued).toBe(false);
    expect(atThreshold.res.statusCode).toBe(402);
    expect((atThreshold.res.body as any).error.required_micro).toBeGreaterThan(PAID_MODEL_MINIMUM_BALANCE_MICRO);

    const funded = callGate('payg-funded@example.com', 10_000_000);
    expect(funded.continued).toBe(true);
    const reservation = db.prepare(`SELECT reserved_micro reservedMicro FROM wallet_reservations
      WHERE user_id = ? AND status = 'reserved'`).get(funded.userId) as { reservedMicro: number };
    expect(reservation.reservedMicro).toBeGreaterThan(PAID_MODEL_MINIMUM_BALANCE_MICRO);
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

    // A model id can legitimately exist on both an ordinary provider and a
    // Codex account. Universal keys must keep the ordinary route instead of
    // being rejected merely because a Codex capability has the same id.
    const collisionId = 'scope-collision-model';
    db.prepare(`INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, monthly_token_budget, enabled, supports_tools
    ) VALUES ('groq', ?, ?, 50, 50, '', '', 1, 1)`).run(collisionId, collisionId);
    db.prepare(`INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, monthly_token_budget, enabled, supports_tools
    ) VALUES ('openai-codex', ?, ?, 50, 50, '', '', 1, 1)`).run(collisionId, collisionId);
    db.prepare(`INSERT INTO model_billing_rules
      (platform, model_id, input_price_micro_per_million, output_price_micro_per_million, multiplier_milli, billing_enabled)
      VALUES ('groq', ?, 0, 0, 1000, 1)`).run(collisionId);
    db.prepare(`INSERT INTO model_billing_rules
      (platform, model_id, input_price_micro_per_million, output_price_micro_per_million, multiplier_milli, billing_enabled)
      VALUES ('openai-codex', ?, 0, 0, 1000, 1)`).run(collisionId);
    expect(callGate(universal.key, collisionId).continued).toBe(true);

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

  it('routes tool-bearing Codex alias requests to a real OAuth capability', () => {
    const db = getDb();
    const userId = Number(db.prepare(`INSERT INTO users (email, password_hash, balance_micro)
      VALUES ('alias-tools@example.com', 'x', 100000000)`).run().lastInsertRowid);
    const key = createConsumerApiKey(db, userId, 'Alias tools', null, 'codex_pool');
    const capability = 'alias-tools-capability';
    db.prepare(`INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, monthly_token_budget, enabled, supports_tools
    ) VALUES ('openai-codex', ?, ?, 50, 50, '', '', 1, 1)`).run(capability, capability);
    db.prepare(`INSERT INTO model_billing_rules
      (platform, model_id, input_price_micro_per_million, output_price_micro_per_million, multiplier_milli, billing_enabled)
      VALUES ('openai-codex', ?, 0, 0, 1000, 1)`).run(capability);
    const accountId = Number(db.prepare(`INSERT INTO codex_oauth_accounts (
      label, access_token_encrypted, access_token_iv, access_token_auth_tag,
      refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag,
      enabled, status, resource_scope, quota_remaining_percent
    ) VALUES ('alias-tools', 'x', 'x', 'x', 'x', 'x', 'x', 1, 'healthy', 'codex_pool', 100)`).run().lastInsertRowid);
    db.prepare(`INSERT INTO codex_oauth_account_models (account_id, model_id, enabled)
      VALUES (?, ?, 1)`).run(accountId, capability);

    const alias = db.prepare(`SELECT id, supports_tools supportsTools FROM models
      WHERE platform = 'openai-codex' AND model_id = 'codex'`).get() as { id: number; supportsTools: number };
    let routed: ReturnType<typeof routeRequest> | null = null;
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any;
    const res = new TestResponse() as any;
    clientContextMiddleware(req, res, () => {
      setConsumerIdentity(userId, key.record.id, 'codex_pool');
      routed = routeRequest(
        10,
        undefined,
        alias.id,
        false,
        true,
        undefined,
        resolveModelGroupCandidates([alias.id]),
      );
    });

    expect(alias.supportsTools).toBe(1);
    expect(routed?.platform).toBe('openai-codex');
    expect(routed?.keyId).toBeLessThan(0);
  });
});
