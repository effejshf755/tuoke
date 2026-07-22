import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { getProvider, resolveProvider } from '../providers/index.js';
import type { BaseProvider } from '../providers/base.js';
import type { Scheduler } from '../lib/scheduler.js';

const MODEL_HEALTH_BOOT_DELAY_MS = 10 * 1000;
const MODEL_HEALTH_INTERVAL_MS = 24 * 60 * 60 * 1000;

let cancelModelHealthBoot: (() => void) | null = null;
let cancelModelHealthInterval: (() => void) | null = null;

export type ModelHealthResult = {
  status: 'success' | 'failed';
  lastCheckedAt: string;
  error: string | null;
  latencyMs: number;
};

type StoredModelHealth = Record<string, ModelHealthResult>;

type ModelHealthRow = {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  key_id: number | null;
};

type ApiKeyRow = {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  base_url: string | null;
};

function healthKey(platform: string, modelId: string): string {
  return `${platform}:${modelId}`;
}

function readHealth(db: ReturnType<typeof getDb>): StoredModelHealth {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'model_health'").get() as { value?: string } | undefined;
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as StoredModelHealth : {};
  } catch {
    return {};
  }
}

function writeHealth(db: ReturnType<typeof getDb>, health: StoredModelHealth): void {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('model_health', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(health));
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function saveResult(db: ReturnType<typeof getDb>, model: ModelHealthRow, result: ModelHealthResult): void {
  const health = readHealth(db);
  health[healthKey(model.platform, model.model_id)] = result;
  writeHealth(db, health);
}

export function getModelHealthMap(db = getDb()): StoredModelHealth {
  return readHealth(db);
}

export async function checkModelHealth(modelDbId: number): Promise<ModelHealthResult> {
  const db = getDb();
  const model = db.prepare(`
    SELECT id, platform, model_id, display_name, key_id
      FROM models
     WHERE id = ?
  `).get(modelDbId) as ModelHealthRow | undefined;

  if (!model) throw Object.assign(new Error('Unknown model'), { statusCode: 404 });

  const startedAt = Date.now();
  const checkedAt = () => new Date().toISOString();
  try {
    const key = model.key_id == null
      ? db.prepare(`
          SELECT id, platform, encrypted_key, iv, auth_tag, base_url
            FROM api_keys
           WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')
           ORDER BY CASE WHEN status = 'healthy' THEN 0 ELSE 1 END, id ASC
           LIMIT 1
        `).get(model.platform) as ApiKeyRow | undefined
      : db.prepare(`
          SELECT id, platform, encrypted_key, iv, auth_tag, base_url
            FROM api_keys
           WHERE id = ? AND platform = ? AND enabled = 1
        `).get(model.key_id, model.platform) as ApiKeyRow | undefined;

    if (!key) throw new Error(`No enabled API key for platform ${model.platform}`);

    const provider: BaseProvider | undefined = model.platform === 'custom'
      ? resolveProvider('custom', key.base_url)
      : getProvider(model.platform as any);
    if (!provider) throw new Error(`No provider registered for platform ${model.platform}`);

    const apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
    await provider.chatCompletion(
      apiKey,
      [{ role: 'user', content: 'health check' }],
      model.model_id,
      { max_tokens: 1, timeoutMs: 60_000 },
    );

    const result: ModelHealthResult = {
      status: 'success',
      lastCheckedAt: checkedAt(),
      error: null,
      latencyMs: Date.now() - startedAt,
    };
    saveResult(db, model, result);
    return result;
  } catch (error) {
    const result: ModelHealthResult = {
      status: 'failed',
      lastCheckedAt: checkedAt(),
      error: errorText(error),
      latencyMs: Date.now() - startedAt,
    };
    saveResult(db, model, result);
    return result;
  }
}

export async function checkAllModelsHealth(concurrency = 2): Promise<{ total: number; success: number; failed: number }> {
  const rows = getDb().prepare('SELECT id FROM models ORDER BY id ASC').all() as Array<{ id: number }>;
  let nextIndex = 0;
  let success = 0;
  let failed = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, rows.length));

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      const row = rows[index];
      if (!row) return;
      const result = await checkModelHealth(row.id);
      if (result.status === 'success') success += 1;
      else failed += 1;
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { total: rows.length, success, failed };
}

export function startModelHealthScheduler(scheduler: Scheduler): void {
  if (cancelModelHealthInterval) return;

  const run = () => {
    void checkAllModelsHealth(2)
      .then((result) => {
        console.log(`[model-health] completed: total=${result.total}, success=${result.success}, failed=${result.failed}`);
      })
      .catch((error) => {
        console.error(`[model-health] scheduled check failed: ${error instanceof Error ? error.message : error}`);
      });
  };

  cancelModelHealthBoot = scheduler.after(MODEL_HEALTH_BOOT_DELAY_MS, run);
  cancelModelHealthInterval = scheduler.every(MODEL_HEALTH_INTERVAL_MS, run, { name: 'model-health-daily-check' });
  console.log('[model-health] scheduled: first check in 10s, then every 24h');
}

export function stopModelHealthScheduler(): void {
  if (cancelModelHealthBoot) {
    cancelModelHealthBoot();
    cancelModelHealthBoot = null;
  }
  if (cancelModelHealthInterval) {
    cancelModelHealthInterval();
    cancelModelHealthInterval = null;
  }
}
