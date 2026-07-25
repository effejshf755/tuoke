import express, { type Express } from 'express';
import { beforeAll, describe, expect, it } from 'vitest';

import { getDb, initDb } from '../../db/index.js';
import { codexOauthRouter } from '../../routes/codex-oauth.js';
import { userRouter } from '../../routes/user.js';

async function call(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

function account(label: string, scope: 'codex_pool' | 'resource_subpool', enabled = 1) {
  return Number(getDb().prepare(`INSERT INTO codex_oauth_accounts (
    label, access_token_encrypted, access_token_iv, access_token_auth_tag,
    refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag,
    resource_scope, enabled
  ) VALUES (?, 'x', 'x', 'x', 'x', 'x', 'x', ?, ?)`).run(label, scope, enabled).lastInsertRowid);
}

function model(accountId: number, modelId: string, enabled = 1) {
  getDb().prepare(`INSERT INTO codex_oauth_account_models (account_id, model_id, enabled)
    VALUES (?, ?, ?)`).run(accountId, modelId, enabled);
}

describe('Codex pay-as-you-go model pricing', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '7'.repeat(64);
    initDb(':memory:');
    app = express();
    app.use(express.json());
    app.use('/api/admin/codex', codexOauthRouter);
    app.use('/api/user', userRouter);

    const pool = account('pool', 'codex_pool');
    const disabledPool = account('disabled-pool', 'codex_pool', 0);
    const subpool = account('subpool', 'resource_subpool');
    model(pool, 'gpt-visible');
    model(pool, 'gpt-hidden');
    model(pool, 'codex-auto-review');
    model(disabledPool, 'gpt-disabled-account');
    model(subpool, 'gpt-subpool-only');
  });

  it('lists only Codex account-pool models for administrators', async () => {
    const response = await call(app, 'GET', '/api/admin/codex/billing');
    expect(response.status).toBe(200);
    expect(response.body.models.map((item: { model_id: string }) => item.model_id)).toEqual([
      'gpt-disabled-account', 'gpt-hidden', 'gpt-visible',
    ]);
    expect(response.body.models[0]).toMatchObject({ total_tokens: 0, last_used_at: null });
  });

  it('synchronizes enabled pricing to users without exposing hidden or subpool models', async () => {
    const visible = await call(app, 'PUT', '/api/admin/codex/billing', {
      model_id: 'gpt-visible', input_price_per_million: 2.5,
      output_price_per_million: 10, multiplier: 1.2, billing_enabled: true,
    });
    expect(visible.status).toBe(200);
    await call(app, 'PUT', '/api/admin/codex/billing', {
      model_id: 'gpt-hidden', input_price_per_million: 1,
      output_price_per_million: 2, multiplier: 1, billing_enabled: false,
    });

    const response = await call(app, 'GET', '/api/user/codex-models');
    expect(response.status).toBe(200);
    expect(response.body.models).toEqual([{
      model_id: 'gpt-visible', input_price_per_million: 2.5,
      output_price_per_million: 10, multiplier: 1.2,
    }]);
  });
});
