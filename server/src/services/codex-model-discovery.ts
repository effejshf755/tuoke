import type { Db } from '../db/types.js';
import { proxyFetch } from '../lib/proxy.js';

const CODEX_MODELS_ENDPOINT = 'https://chatgpt.com/backend-api/codex/models';
const DEFAULT_CODEX_CLIENT_VERSION = '0.145.0';
type UnknownRecord = Record<string, unknown>;

function modelIdFrom(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as UnknownRecord;
  for (const key of ['slug', 'id', 'model', 'model_id']) {
    const candidate = row[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function parseCodexModelIds(payload: unknown): string[] {
  const body = payload as UnknownRecord | null;
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(body?.models) ? body.models
    : Array.isArray(body?.data) ? body.data
    : [];
  return [...new Set(rows.map(modelIdFrom).filter((id): id is string => id !== null))];
}

export async function discoverCodexModels(accessToken: string, accountId?: string | null): Promise<string[]> {
  const clientVersion = process.env.CODEX_CLIENT_VERSION?.trim() || DEFAULT_CODEX_CLIENT_VERSION;
  const response = await proxyFetch(
    `${CODEX_MODELS_ENDPOINT}?client_version=${encodeURIComponent(clientVersion)}`,
    { headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    } },
    'openai-codex',
  );
  if (!response.ok) throw new Error(`Codex model discovery failed with HTTP ${response.status}`);
  const modelIds = parseCodexModelIds(await response.json());
  if (modelIds.length === 0) throw new Error('Codex model discovery returned no models');
  return modelIds;
}

export function replaceCodexAccountModels(db: Db, accountId: number, modelIds: string[]): void {
  db.transaction(() => {
    db.prepare(`UPDATE codex_oauth_account_models SET enabled=0, updated_at=datetime('now') WHERE account_id=?`).run(accountId);
    const upsert = db.prepare(`
      INSERT INTO codex_oauth_account_models (account_id, model_id, enabled) VALUES (?, ?, 1)
      ON CONFLICT(account_id, model_id) DO UPDATE SET enabled=1, updated_at=datetime('now')
    `);
    const createBillingRule = db.prepare(`
      INSERT OR IGNORE INTO model_billing_rules (
        platform,
        model_id,
        input_price_micro_per_million,
        output_price_micro_per_million,
        multiplier_milli,
        billing_enabled
      ) VALUES ('openai-codex', ?, 0, 0, 1000, 1)
    `);
    for (const modelId of modelIds) {
      upsert.run(accountId, modelId);
      createBillingRule.run(modelId);
    }
  })();
}
