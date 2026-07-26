import { Router, type RequestHandler } from 'express';
import { getDb } from '../db/index.js';
import { z } from 'zod';

import {
  listCodexAccounts,
  deleteCodexAccount,
  setCodexAccountEnabled,
  createCodexAccount,
  checkCodexAccountHealth,
  setCodexAccountScope,
} from '../services/codex-oauth.js';

import { importCodexAuthPayload, importLocalCodexAuth } from '../services/codex-import.js';
import { replaceCodexAccountModels } from '../services/codex-model-discovery.js';
import { getCodexUsageStats } from '../services/codex-usage.js';

export const codexOauthRouter = Router();

const updateAccountSchema = z.object({
  enabled: z.boolean().optional(),
  resource_scope: z.enum(['codex_pool', 'resource_subpool']).optional(),
}).strict().refine(value => value.enabled !== undefined || value.resource_scope !== undefined);

const updateCodexBillingSchema = z.object({
  model_id: z.string().trim().min(1).max(200),
  input_price_per_million: z.number().finite().min(0).max(1_000_000),
  output_price_per_million: z.number().finite().min(0).max(1_000_000),
  multiplier: z.number().finite().min(0).max(1_000),
  cached_input_multiplier: z.number().finite().min(0).max(1_000),
  billing_enabled: z.boolean(),
}).strict();

function microToCurrency(value: number): number {
  return Number((Number(value || 0) / 1_000_000).toFixed(6));
}

function currencyToMicro(value: number): number {
  return Math.round(value * 1_000_000);
}

function milliToMultiplier(value: number): number {
  return Number((Number(value || 0) / 1_000).toFixed(3));
}

codexOauthRouter.get('/stats', (_req, res) => {
  res.json(getCodexUsageStats());
});

codexOauthRouter.get('/billing', (_req, res) => {
  const rows = getDb().prepare(`
    SELECT
      am.model_id,
      COUNT(DISTINCT am.account_id) AS account_count,
      SUM(CASE WHEN a.enabled = 1 AND am.enabled = 1 THEN 1 ELSE 0 END)
        AS enabled_account_count,
      COALESCE(b.input_price_micro_per_million, 0) AS input_price,
      COALESCE(b.output_price_micro_per_million, 0) AS output_price,
      COALESCE(b.multiplier_milli, 1000) AS multiplier,
      COALESCE(b.cached_input_multiplier_milli, 1000) AS cached_input_multiplier,
      COALESCE(b.billing_enabled, 1) AS billing_enabled,
      COALESCE(usage.total_tokens, 0) AS total_tokens,
      usage.last_used_at
    FROM codex_oauth_account_models am
    JOIN codex_oauth_accounts a ON a.id = am.account_id
    LEFT JOIN model_billing_rules b
      ON b.platform = 'openai-codex'
     AND b.model_id = am.model_id
    LEFT JOIN (
      SELECT model_id, SUM(total_tokens) AS total_tokens, MAX(created_at) AS last_used_at
      FROM codex_usage_records
      GROUP BY model_id
    ) usage ON usage.model_id = am.model_id
    WHERE a.resource_scope = 'codex_pool'
    GROUP BY am.model_id
    ORDER BY CASE am.model_id
      WHEN 'gpt-5.6-sol' THEN 1
      WHEN 'gpt-5.6-terra' THEN 2
      WHEN 'gpt-5.6-luna' THEN 3
      WHEN 'gpt-5.5' THEN 4
      WHEN 'gpt-5.4-mini' THEN 5
      WHEN 'gpt-5.4' THEN 6
      ELSE 999
    END, am.model_id ASC
  `).all() as Array<{
    model_id: string;
    account_count: number;
    enabled_account_count: number;
    input_price: number;
    output_price: number;
    multiplier: number;
    cached_input_multiplier: number;
    billing_enabled: number;
    total_tokens: number;
    last_used_at: string | null;
  }>;

  res.json({
    models: rows.map((row) => ({
      model_id: row.model_id,
      account_count: Number(row.account_count || 0),
      enabled_account_count: Number(row.enabled_account_count || 0),
      input_price_per_million: microToCurrency(row.input_price),
      output_price_per_million: microToCurrency(row.output_price),
      multiplier: milliToMultiplier(row.multiplier),
      cached_input_multiplier: milliToMultiplier(row.cached_input_multiplier),
      billing_enabled: Boolean(row.billing_enabled),
      total_tokens: Number(row.total_tokens || 0),
      last_used_at: row.last_used_at,
    })),
  });
});

codexOauthRouter.put('/billing', (req, res) => {
  const parsed = updateCodexBillingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { message: 'Invalid Codex billing configuration', type: 'validation_error' },
    });
    return;
  }

  const db = getDb();
  const capability = db.prepare(`
    SELECT 1
    FROM codex_oauth_account_models
    WHERE model_id = ?
    LIMIT 1
  `).get(parsed.data.model_id);
  if (!capability) {
    res.status(404).json({
      error: { message: 'Codex model capability not found', type: 'not_found' },
    });
    return;
  }

  db.prepare(`
    INSERT INTO model_billing_rules (
      platform,
      model_id,
      input_price_micro_per_million,
      output_price_micro_per_million,
      multiplier_milli,
      cached_input_multiplier_milli,
      billing_enabled
    ) VALUES ('openai-codex', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, model_id) DO UPDATE SET
      input_price_micro_per_million = excluded.input_price_micro_per_million,
      output_price_micro_per_million = excluded.output_price_micro_per_million,
      multiplier_milli = excluded.multiplier_milli,
      cached_input_multiplier_milli = excluded.cached_input_multiplier_milli,
      billing_enabled = excluded.billing_enabled,
      updated_at = datetime('now')
  `).run(
    parsed.data.model_id,
    currencyToMicro(parsed.data.input_price_per_million),
    currencyToMicro(parsed.data.output_price_per_million),
    Math.round(parsed.data.multiplier * 1_000),
    Math.round(parsed.data.cached_input_multiplier * 1_000),
    parsed.data.billing_enabled ? 1 : 0,
  );

  res.json({ success: true, model: parsed.data });
});

// Canonical administrator account-pool API.
codexOauthRouter.get('/accounts', (_req, res) => {
  res.json({ accounts: listCodexAccounts(getDb()) });
});

codexOauthRouter.put('/accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  const parsed = updateAccountSchema.safeParse(req.body);
  if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
    res.status(400).json({ error: { message: 'Invalid account update', type: 'validation_error' } });
    return;
  }

  try {
    if (parsed.data.enabled !== undefined && !setCodexAccountEnabled(getDb(), id, parsed.data.enabled)) {
      res.status(404).json({ error: { message: 'Codex OAuth account not found', type: 'not_found' } });
      return;
    }
    if (parsed.data.resource_scope !== undefined && !setCodexAccountScope(getDb(), id, parsed.data.resource_scope)) {
      res.status(404).json({ error: { message: 'Codex OAuth account not found', type: 'not_found' } });
      return;
    }
  } catch (error) {
    res.status(409).json({ error: { message: error instanceof Error ? error.message : String(error), type: 'scope_conflict' } });
    return;
  }

  const account = listCodexAccounts(getDb()).find(item => item.id === id);
  res.json({ success: true, account });
});

codexOauthRouter.post('/accounts/:id/health-check', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid account id', type: 'validation_error' } });
    return;
  }
  try {
    const account = await checkCodexAccountHealth(getDb(), id);
    res.json({ success: account.status === 'healthy', account });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Codex account health check failed';
    res.status(message === 'Codex OAuth account not found' ? 404 : 500).json({
      error: { message, type: message === 'Codex OAuth account not found' ? 'not_found' : 'server_error' },
    });
  }
});

codexOauthRouter.post('/import-auth-json', async (req, res) => {
  try {
    const data = await importCodexAuthPayload(req.body);
    const db = getDb();
    const accountDbId = createCodexAccount(db, {
      label: typeof req.body?.email === 'string' ? req.body.email : 'Codex OAuth',
      account_id: data.account_id ?? undefined,
      access_token_encrypted: data.access_token_encrypted,
      access_token_iv: data.access_token_iv,
      access_token_auth_tag: data.access_token_auth_tag,
      refresh_token_encrypted: data.refresh_token_encrypted,
      refresh_token_iv: data.refresh_token_iv,
      refresh_token_auth_tag: data.refresh_token_auth_tag,
    });
    if (data.model_ids.length > 0) replaceCodexAccountModels(db, accountDbId, data.model_ids);
    res.json({
      success: true,
      account_id: data.account_id,
      models: data.model_ids,
      model_discovery_error: data.model_discovery_error,
    });
  } catch (error) {
    res.status(400).json({
      error: {
        message: error instanceof Error ? error.message : 'Invalid Codex auth.json',
        type: 'validation_error',
      },
    });
  }
});


// 获取账号列表
codexOauthRouter.get('/', (_req, res) => {
  const accounts = listCodexAccounts(getDb());
  res.json({ accounts });
});


// 删除账号
const deleteAccountHandler: RequestHandler = (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    res.status(400).json({
      error: {
        message: 'Invalid id',
        type: 'validation_error',
      },
    });
    return;
  }

  try {
    if (!deleteCodexAccount(getDb(), id)) {
      res.status(404).json({ error: { message: 'Codex OAuth account not found', type: 'not_found' } });
      return;
    }
  } catch (error) {
    res.status(409).json({
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: 'account_in_use',
      },
    });
    return;
  }

  res.json({
    success: true,
  });
};

codexOauthRouter.delete('/accounts/:id', deleteAccountHandler);
codexOauthRouter.delete('/:id', deleteAccountHandler);


// 启用/禁用账号
codexOauthRouter.patch('/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const enabled = Boolean(req.body.enabled);

  if (!Number.isInteger(id)) {
    res.status(400).json({
      error: {
        message: 'Invalid id',
        type: 'validation_error',
      },
    });
    return;
  }

  setCodexAccountEnabled(
    getDb(),
    id,
    enabled,
  );

  res.json({
    success: true,
  });
});
codexOauthRouter.post('/', (req, res) => {
    const {
      label,
      account_id,
      access_token_encrypted,
      access_token_iv,
      access_token_auth_tag,
      refresh_token_encrypted,
      refresh_token_iv,
      refresh_token_auth_tag,
      token_expires_at,
    } = req.body;
  
    if (
      !label ||
      !access_token_encrypted ||
      !access_token_iv ||
      !access_token_auth_tag ||
      !refresh_token_encrypted ||
      !refresh_token_iv ||
      !refresh_token_auth_tag
    ) {
      res.status(400).json({
        error: {
          message: 'Missing required fields',
          type: 'validation_error',
        },
      });
      return;
    }
  
    getDb()
      .prepare(`
        INSERT INTO codex_oauth_accounts (
          label,
          account_id,
          access_token_encrypted,
          access_token_iv,
          access_token_auth_tag,
          refresh_token_encrypted,
          refresh_token_iv,
          refresh_token_auth_tag,
          token_expires_at,
          enabled
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `)
      .run(
        label,
        account_id ?? null,
        access_token_encrypted,
        access_token_iv,
        access_token_auth_tag,
        refresh_token_encrypted,
        refresh_token_iv,
        refresh_token_auth_tag,
        token_expires_at ?? null,
      );
  
    res.json({
      success: true,
    });
  });
  codexOauthRouter.post('/import-local', async (_req, res) => {
    try {
      const data = await importLocalCodexAuth();
      const db = getDb();
      const accountDbId = createCodexAccount(db, {
        label: 'Local Codex',
        account_id: data.account_id ?? undefined,
        access_token_encrypted: data.access_token_encrypted,
        access_token_iv: data.access_token_iv,
        access_token_auth_tag: data.access_token_auth_tag,
        refresh_token_encrypted: data.refresh_token_encrypted,
        refresh_token_iv: data.refresh_token_iv,
        refresh_token_auth_tag: data.refresh_token_auth_tag,
      });
      if (data.model_ids.length > 0) replaceCodexAccountModels(db, accountDbId, data.model_ids);
  
      res.json({
        success: true,
        account_id: data.account_id,
        models: data.model_ids,
        model_discovery_error: data.model_discovery_error,
      });
  
    } catch (error) {
      res.status(500).json({
        error: {
          message: error instanceof Error ? error.message : 'Import failed',
          type: 'server_error',
        },
      });
    }
  });
