import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createConsumerApiKey, type ConsumerApiKeyType } from '../../services/consumer-api-keys.js';

let app: Express;
let sequence = 0;

async function listModels(key: string, anthropic = false) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/models`, {
    headers: anthropic
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${key}` },
  });
  const body = await response.json() as { data: Array<{ id: string; owned_by?: string; supported_parameters?: string[] }> };
  server.close();
  return { status: response.status, ids: body.data.map(model => model.id), data: body.data };
}

async function postResponses(key: string, model: string) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: 'hello', stream: false, max_output_tokens: 8 }),
  });
  const body = await response.json() as { error?: { code?: string; type?: string } };
  server.close();
  return { status: response.status, body };
}

async function postModelRequest(
  key: string,
  surface: 'chat' | 'completions' | 'messages',
  model: string,
) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const path = surface === 'chat'
    ? '/v1/chat/completions'
    : surface === 'completions'
      ? '/v1/completions'
      : '/v1/messages';
  const body = surface === 'chat'
    ? { model, messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 }
    : surface === 'completions'
      ? { model, prompt: 'hello', max_tokens: 8 }
      : { model, messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(surface === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}),
    },
    body: JSON.stringify(body),
  });
  const result = await response.json() as { error?: { code?: string; message?: string } };
  server.close();
  return { status: response.status, body: result };
}

function createKey(type: ConsumerApiKeyType): string {
  sequence += 1;
  const userId = Number(getDb().prepare(
    'INSERT INTO users (email, password_hash, balance_micro) VALUES (?, ?, 100000000)',
  ).run(`model-list-${sequence}@example.com`, 'test').lastInsertRowid);
  return createConsumerApiKey(getDb(), userId, `${type}-${sequence}`, null, type).key;
}

describe('consumer model listing isolation', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM resource_subpool_bindings').run();
    db.prepare('DELETE FROM resource_subpool_members').run();
    db.prepare('DELETE FROM resource_subpools').run();
    db.prepare('DELETE FROM consumer_api_keys').run();
    db.prepare('DELETE FROM codex_oauth_account_models').run();
    db.prepare('DELETE FROM codex_oauth_accounts').run();
    db.prepare("DELETE FROM api_keys WHERE label='consumer-model-listing'").run();
    db.prepare("DELETE FROM model_billing_rules WHERE model_id IN ('test-ordinary','test-collision','test-codex-shared','test-codex-dedicated','test-codex-unavailable')").run();
    db.prepare("DELETE FROM models WHERE model_id IN ('test-ordinary','test-collision','test-codex-shared','test-codex-dedicated','test-codex-unavailable')").run();
    db.prepare("DELETE FROM settings WHERE key = 'model_health'").run();

    db.prepare(`INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, monthly_token_budget, enabled, supports_vision, supports_tools
    ) VALUES ('groq', 'test-ordinary', 'Test ordinary', 50, 50, '', '', 1, 0, 1)`).run();
    db.prepare(`INSERT INTO api_keys
      (platform, label, encrypted_key, iv, auth_tag, enabled, status)
      VALUES ('groq', 'consumer-model-listing', 'x', 'x', 'x', 1, 'healthy')`).run();
    db.prepare(`INSERT INTO model_billing_rules
      (platform, model_id, input_price_micro_per_million, output_price_micro_per_million, multiplier_milli, billing_enabled)
      VALUES ('groq', 'test-ordinary', 0, 0, 1000, 1)`).run();

    db.prepare(`INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, monthly_token_budget, enabled, supports_vision, supports_tools
    ) VALUES ('groq', 'test-collision', 'Test collision', 50, 50, '', '', 1, 0, 0)`).run();
    db.prepare(`INSERT INTO model_billing_rules
      (platform, model_id, input_price_micro_per_million, output_price_micro_per_million, multiplier_milli, billing_enabled)
      VALUES ('groq', 'test-collision', 0, 0, 1000, 1)`).run();
    db.prepare(`INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, monthly_token_budget, enabled, supports_vision, supports_tools
    ) VALUES ('openai-codex', 'test-collision', 'Test collision', 1, 1, '', '', 1, 1, 1)`).run();
    db.prepare(`INSERT INTO model_billing_rules
      (platform, model_id, input_price_micro_per_million, output_price_micro_per_million, multiplier_milli, billing_enabled)
      VALUES ('openai-codex', 'test-collision', 0, 0, 1000, 1)`).run();

    for (const modelId of ['test-codex-shared', 'test-codex-dedicated', 'test-codex-unavailable']) {
      db.prepare(`INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank,
        size_label, monthly_token_budget, enabled, supports_vision, supports_tools
      ) VALUES ('openai-codex', ?, ?, 50, 50, '', '', 1, 1, 1)`).run(modelId, modelId);
      db.prepare(`INSERT INTO model_billing_rules
        (platform, model_id, input_price_micro_per_million, output_price_micro_per_million, multiplier_milli, billing_enabled)
        VALUES ('openai-codex', ?, 0, 0, 1000, 1)`).run(modelId);
    }

    const sharedAccountId = Number(db.prepare(`INSERT INTO codex_oauth_accounts (
      label, access_token_encrypted, access_token_iv, access_token_auth_tag,
      refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag,
      enabled, status, resource_scope, quota_remaining_percent
      ) VALUES ('shared@example.com', 'x', 'x', 'x', 'x', 'x', 'x', 1, 'healthy', 'codex_pool', 100)`).run().lastInsertRowid);
    const dedicatedAccountId = Number(db.prepare(`INSERT INTO codex_oauth_accounts (
      label, access_token_encrypted, access_token_iv, access_token_auth_tag,
      refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag,
      enabled, status, resource_scope, quota_remaining_percent
      ) VALUES ('dedicated@example.com', 'x', 'x', 'x', 'x', 'x', 'x', 1, 'healthy', 'resource_subpool', 100)`).run().lastInsertRowid);
    db.prepare(`INSERT INTO codex_oauth_account_models (account_id, model_id, enabled)
      VALUES (?, 'test-codex-shared', 1)`).run(sharedAccountId);
    db.prepare(`INSERT INTO codex_oauth_account_models (account_id, model_id, enabled)
      VALUES (?, 'test-codex-dedicated', 1)`).run(dedicatedAccountId);
  });

  it.each(['codex_pool', 'resource_subpool'] as const)(
    '%s keys discover real models from their permitted Codex account scope',
    async keyType => {
      const db = getDb();
      db.prepare(`INSERT INTO settings (key, value) VALUES ('model_health', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify({
        'openai-codex:codex': {
          status: 'failed',
          lastCheckedAt: new Date().toISOString(),
          error: 'No enabled ordinary provider API key',
          latencyMs: 0,
        },
      }));

      const key = createKey(keyType);
      const accountId = (db.prepare(`SELECT id FROM codex_oauth_accounts
        WHERE label = ?`).get(keyType === 'resource_subpool' ? 'dedicated@example.com' : 'shared@example.com') as { id: number }).id;
      if (keyType === 'resource_subpool') {
        const keyRow = db.prepare('SELECT id, user_id userId FROM consumer_api_keys WHERE key_scope = ? ORDER BY id DESC LIMIT 1').get(keyType) as { id: number; userId: number };
        const subpoolId = Number(db.prepare(`INSERT INTO resource_subpools (name, mode, status, member_limit)
          VALUES ('listing-pool', 'dedicated', 'active', 1)`).run().lastInsertRowid);
        const memberId = Number(db.prepare(`INSERT INTO resource_subpool_members
          (subpool_id, user_id, consumer_api_key_id, status) VALUES (?, ?, ?, 'active')`).run(subpoolId, keyRow.userId, keyRow.id).lastInsertRowid);
        db.prepare(`INSERT INTO resource_subpool_bindings (subpool_id, codex_account_id, status)
          VALUES (?, ${accountId}, 'active')`).run(subpoolId);
        void memberId;
      }
      const openai = await listModels(key);
      const anthropic = await listModels(key, true);
      const expected = keyType === 'resource_subpool'
        ? ['test-codex-dedicated']
        : ['test-codex-shared'];

      expect({ status: openai.status, ids: openai.ids }).toEqual({ status: 200, ids: expected });
      expect({ status: anthropic.status, ids: anthropic.ids }).toEqual({ status: 200, ids: expected });
    },
  );

  it('universal keys discover ordinary models but never Codex models', async () => {
    const result = await listModels(createKey('universal'));
    expect(result.status).toBe(200);
    expect(result.ids).toContain('test-ordinary');
    expect(result.ids).not.toContain('test-codex-shared');
    expect(result.ids).not.toContain('test-codex-dedicated');
    expect(result.ids).not.toContain('test-codex-unavailable');
    expect(result.ids).toContain('auto');

    const collision = result.data.find(model => model.id === 'test-collision');
    expect(collision?.owned_by).not.toBe('openai-codex');
    expect(collision?.supported_parameters).not.toContain('tools');
  });

  it('rejects a globally known Codex model that this pool key cannot use', async () => {
    const result = await postResponses(createKey('codex_pool'), 'test-codex-unavailable');
    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('model_not_available_for_key');
  });

  it.each(['chat', 'completions', 'messages'] as const)(
    'rejects a cross-scope Codex model on the %s surface without fallback',
    async surface => {
      const result = await postModelRequest(createKey('codex_pool'), surface, 'test-codex-unavailable');
      expect(result.status).toBe(400);
      expect(result.body.error?.message).toContain('not available for this API key');
      if (surface !== 'messages') {
        expect(result.body.error?.code).toBe('model_not_available_for_key');
      }
    },
  );
});
