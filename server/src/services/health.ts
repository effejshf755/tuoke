import { getDb } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import type { Platform, KeyStatus } from '@freellmapi/shared/types.js';
import { inferQuotaPoolKey, recordQuotaObservation } from './provider-quota.js';
import type { Scheduler } from '../lib/scheduler.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CONSECUTIVE_FAILURES_TO_DISABLE = 3;

// Track consecutive failures per key
const failureCount = new Map<number, number>();

async function refreshOpenRouterCredits(keyId: number, apiKey: string): Promise<void> {
  const endpoint = 'https://openrouter.ai/api/v1/credits';
  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await response.text();
    let body: any = null;
    try { body = JSON.parse(raw); } catch { /* preserve the raw response only in the observation */ }
    const total = Number(body?.data?.total_credits);
    const used = Number(body?.data?.total_usage);
    const hasCredits = Number.isFinite(total) && Number.isFinite(used);
    recordQuotaObservation({
      platform: 'openrouter',
      keyId,
      quotaPoolKey: `openrouter::key:${keyId}`,
      metric: 'credits',
      limit: hasCredits ? total : null,
      remaining: hasCredits ? Math.max(0, total - used) : null,
      source: 'quota_api',
      statusCode: response.status,
      endpoint,
      notes: response.ok
        ? (hasCredits ? 'OpenRouter 账户额度' : 'OpenRouter 未返回账户额度；请使用 Management Key')
        : `OpenRouter 额度查询失败（HTTP ${response.status}）；普通推理 Key 可能无权限，请使用 Management Key`,
      rawJson: raw.slice(0, 2000),
      confidence: response.ok && hasCredits ? 1 : 0.75,
    });
  } catch (err: any) {
    recordQuotaObservation({
      platform: 'openrouter',
      keyId,
      quotaPoolKey: `openrouter::key:${keyId}`,
      metric: 'credits',
      source: 'quota_api',
      endpoint,
      notes: `OpenRouter 额度查询异常：${err?.message ?? 'unknown error'}`,
      confidence: 0.5,
    });
  }
}

export async function checkKeyHealth(keyId: number): Promise<KeyStatus> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
  if (!row) return 'error';

  const provider = resolveProvider(row.platform as Platform, row.base_url);
  if (!provider) return 'error';

  try {
    const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    const isValid = await provider.validateKey(apiKey, {
      platform: row.platform as Platform,
      keyId,
      quotaPoolKey: inferQuotaPoolKey(row.platform as Platform, null),
      endpoint: 'models',
      origin: 'health',
    });

    // Keep account-level balance separate for every key. A normal OpenRouter
    // inference key may not be allowed to read /credits; that limitation is
    // recorded as a quota observation without making an otherwise valid key
    // unusable.
    if (row.platform === 'openrouter') {
      await refreshOpenRouterCredits(keyId, apiKey);
    }

    const status: KeyStatus = isValid ? 'healthy' : 'invalid';

    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run(status, keyId);

    if (isValid) {
      failureCount.delete(keyId);
    } else {
      const count = (failureCount.get(keyId) ?? 0) + 1;
      failureCount.set(keyId, count);

      if (count >= CONSECUTIVE_FAILURES_TO_DISABLE) {
        db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(keyId);
        console.log(`[Health] Auto-disabled key ${keyId} after ${count} consecutive failures`);
      }
    }

    return status;
  } catch (err: any) {
    // Transport errors (DNS/timeout/TLS) — provider unreachable, not necessarily
    // a bad key. Mark status='error' but do NOT increment failure counter — auto-
    // disable is reserved for confirmed 401/403 (returned by validateKey as false).
    // Include platform + base_url so a flapping CloudFront edge or DNS failure is
    // attributable to the responsible provider in one log read. The leading
    // "[Health] Key N (" prefix is preserved so the 12-hourly crash watchdog
    // (cron bff5ae167d28) that scrapes /tmp/freellmapi.log for these lines
    // continues to match unchanged.
    console.error(
      `[Health] Key ${keyId} (${row.platform}, base=${row.base_url ?? 'default'}) ` +
      `transport error: ${err.message}`,
    );
    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run('error', keyId);
    return 'error';
  }
}

// Overlap guard: the scheduled 5-minute pass and wake-recovery re-probes can
// coincide (or SIGCONT spam can queue several) — concurrent full passes
// multiply provider validate traffic and let two passes each increment the
// same genuinely-bad key's failureCount, reaching the auto-disable threshold
// in fewer wall-clock checks than "3 consecutive checks" intends. A second
// caller joins the in-flight pass instead of starting another.
let checkAllInFlight: Promise<void> | null = null;

export function checkAllKeys(): Promise<void> {
  if (checkAllInFlight) return checkAllInFlight;
  checkAllInFlight = (async () => {
    const db = getDb();
    const keys = db.prepare('SELECT id, platform FROM api_keys WHERE enabled = 1').all() as { id: number; platform: string }[];

    console.log(`[Health] Checking ${keys.length} keys...`);

    for (const key of keys) {
      await checkKeyHealth(key.id);
    }

    console.log(`[Health] Check complete.`);
  })().finally(() => {
    checkAllInFlight = null;
  });
  return checkAllInFlight;
}

let cancelHealthCheck: (() => void) | null = null;

export function startHealthChecker(scheduler: Scheduler): void {
  if (cancelHealthCheck) return;
  console.log(`[Health] Starting health checker (every ${CHECK_INTERVAL_MS / 1000}s)`);
  cancelHealthCheck = scheduler.every(CHECK_INTERVAL_MS, () =>
    checkAllKeys().catch(err => console.error('[Health] Check failed:', err)),
  );
}

export function stopHealthChecker(): void {
  if (cancelHealthCheck) {
    cancelHealthCheck();
    cancelHealthCheck = null;
  }
}
