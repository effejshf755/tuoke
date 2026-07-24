import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(scriptDir, '../../../.env') });

type AccountCandidate = {
  id: number;
  label: string;
  modelId: string;
  accessTokenEncrypted: string;
  accessTokenIv: string;
  accessTokenAuthTag: string;
};

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function asInt(value: unknown): number {
  return Number(value ?? 0);
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const keepFixture = process.argv.includes('--keep-fixture');
  const requestedAccountId = argument('account-id') ?? process.env.RESOURCE_LIVE_CODEX_ACCOUNT_ID;
  const requestedModel = argument('model') ?? process.env.RESOURCE_LIVE_CODEX_MODEL;

  const [{ initDb, getDb }, { decrypt }, { createConsumerApiKey }, { createApp }] = await Promise.all([
    import('../db/index.js'),
    import('../lib/crypto.js'),
    import('../services/consumer-api-keys.js'),
    import('../app.js'),
  ]);

  initDb();
  const db = getDb();
  const candidates = db.prepare(`SELECT a.id, a.label,
      am.model_id modelId,
      a.access_token_encrypted accessTokenEncrypted,
      a.access_token_iv accessTokenIv,
      a.access_token_auth_tag accessTokenAuthTag
    FROM codex_oauth_accounts a
    JOIN codex_oauth_account_models am ON am.account_id = a.id AND am.enabled = 1
    JOIN model_billing_rules br ON br.platform = 'openai-codex'
      AND br.model_id = am.model_id AND br.billing_enabled = 1
    WHERE a.enabled = 1 AND a.status IN ('healthy', 'unknown')
      AND (a.cooldown_until IS NULL OR datetime(a.cooldown_until) <= datetime('now'))
      AND (? IS NULL OR a.id = CAST(? AS INTEGER))
      AND (? IS NULL OR am.model_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM resource_subpool_bindings b
        WHERE b.codex_account_id = a.id AND b.status IN ('active', 'migrating')
      )
    ORDER BY a.id, am.model_id`).all(
      requestedAccountId ?? null,
      requestedAccountId ?? null,
      requestedModel ?? null,
      requestedModel ?? null,
    ) as AccountCandidate[];

  let selected: AccountCandidate | undefined;
  const rejected: Array<{ accountId: number; label: string; reason: string }> = [];
  for (const candidate of candidates) {
    try {
      const token = decrypt(candidate.accessTokenEncrypted, candidate.accessTokenIv, candidate.accessTokenAuthTag);
      if (!token.trim()) throw new Error('decrypted token is empty');
      selected = candidate;
      break;
    } catch (error) {
      rejected.push({
        accountId: candidate.id,
        label: candidate.label,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const preflight = {
    database: process.env.FREEAPI_DB_PATH?.trim() || 'server/data/freeapi.db',
    proxyConfigured: Boolean(process.env.PROXY_URL?.trim()),
    encryptionKeySource: process.env.ENCRYPTION_KEY?.trim() ? 'ENCRYPTION_KEY' : 'local key file/database fallback',
    selectedAccount: selected ? { id: selected.id, label: selected.label, model: selected.modelId } : null,
    rejectedAccounts: rejected,
  };
  console.log(JSON.stringify({ phase: 'preflight', ...preflight }, null, 2));
  if (!selected) throw new Error('No unbound, enabled, healthy, decryptable Codex account/model is available');
  if (!execute) {
    console.log('Preflight passed. Re-run with --execute to send one real Codex request.');
    return;
  }

  const runId = `${Date.now()}-${process.pid}`;
  const fixture = db.transaction(() => {
    const userId = Number(db.prepare(`INSERT INTO users (email, password_hash, balance_micro)
      VALUES (?, 'live-verification-only', 0)`).run(`resource-live-${runId}@example.invalid`).lastInsertRowid);
    const apiKey = createConsumerApiKey(db, userId, `Resource live verification ${runId}`, null, 'resource_subpool');
    const subpoolId = Number(db.prepare(`INSERT INTO resource_subpools (
      name, mode, legacy_status, status, member_limit, starts_at, ends_at,
      frozen_total_quota_units, frozen_member_quota_units, frozen_meter_version, frozen_at
    ) VALUES (?, 'dedicated', 'active', 'active', 1, datetime('now'), datetime('now', '+1 day'),
      100000, 100000, 'tokens-v1', datetime('now'))`).run(`Live verification ${runId}`).lastInsertRowid);
    const memberId = Number(db.prepare(`INSERT INTO resource_subpool_members (
      subpool_id, user_id, consumer_api_key_id, status, activated_at, expires_at
    ) VALUES (?, ?, ?, 'active', datetime('now'), datetime('now', '+1 day'))`)
      .run(subpoolId, userId, apiKey.record.id).lastInsertRowid);
    const bindingId = Number(db.prepare(`INSERT INTO resource_subpool_bindings
      (subpool_id, codex_account_id, status) VALUES (?, ?, 'active')`)
      .run(subpoolId, selected.id).lastInsertRowid);
    const periodId = Number(db.prepare(`INSERT INTO resource_subpool_quota_periods (
      subpool_id, period_key, source_type, source_account_id, allocation_units,
      starts_at, resets_at, meter_version, status
    ) VALUES (?, ?, 'admin', ?, 100000, datetime('now'), datetime('now', '+1 day'), 'tokens-v1', 'active')`)
      .run(subpoolId, `live-verification:${runId}`, selected.id).lastInsertRowid);
    const memberQuotaId = Number(db.prepare(`INSERT INTO resource_member_quotas
      (subpool_period_id, member_id, allocation_units, status)
      VALUES (?, ?, 100000, 'active')`).run(periodId, memberId).lastInsertRowid);
    return { userId, apiKey, subpoolId, memberId, bindingId, periodId, memberQuotaId };
  })();

  const before = {
    walletMicro: asInt((db.prepare(`SELECT balance_micro value FROM users WHERE id = ?`)
      .get(fixture.userId) as { value: number }).value),
    subpoolUsed: asInt((db.prepare(`SELECT used_units value FROM resource_subpool_quota_periods WHERE id = ?`)
      .get(fixture.periodId) as { value: number }).value),
    memberUsed: asInt((db.prepare(`SELECT used_units value FROM resource_member_quotas WHERE id = ?`)
      .get(fixture.memberQuotaId) as { value: number }).value),
  };

  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  let responseStatus = 0;
  let responseBody: any;
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test HTTP server did not expose a TCP port');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.apiKey.key}`,
        'Content-Type': 'application/json',
        'X-Resource-Live-Verification': runId,
      },
      body: JSON.stringify({
        model: 'codex',
        messages: [{ role: 'user', content: 'Reply with exactly: RESOURCE_CODEX_OK' }],
        stream: false,
        max_tokens: 32,
      }),
    });
    responseStatus = response.status;
    const text = await response.text();
    try { responseBody = JSON.parse(text); }
    catch { responseBody = { raw: text.slice(0, 1_000) }; }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const dispatch = db.prepare(`SELECT id, codex_account_id accountId, model_id modelId,
      status, decision_reason decisionReason, error
    FROM resource_dispatches WHERE subpool_id = ? ORDER BY id DESC LIMIT 1`)
    .get(fixture.subpoolId) as any;
  const reservation = db.prepare(`SELECT id, reserved_units reservedUnits,
      actual_units actualUnits, request_id requestId, status
    FROM resource_quota_reservations WHERE subpool_id = ? ORDER BY id DESC LIMIT 1`)
    .get(fixture.subpoolId) as any;
  const request = reservation?.requestId == null ? null : db.prepare(`SELECT id, platform, model_id modelId,
      status, input_tokens inputTokens, output_tokens outputTokens,
      billing_amount_micro billingAmountMicro, billing_status billingStatus
    FROM requests WHERE id = ?`).get(reservation.requestId) as any;
  const usage = reservation?.requestId == null ? null : db.prepare(`SELECT id, account_id accountId,
      account_label accountLabel, model_id modelId, input_tokens inputTokens,
      output_tokens outputTokens, total_tokens totalTokens, success,
      billing_amount_micro billingAmountMicro, billing_status billingStatus, request_id requestId
    FROM codex_usage_records WHERE request_id = ? ORDER BY id DESC LIMIT 1`)
    .get(reservation.requestId) as any;
  const after = {
    walletMicro: asInt((db.prepare(`SELECT balance_micro value FROM users WHERE id = ?`)
      .get(fixture.userId) as { value: number }).value),
    subpoolUsed: asInt((db.prepare(`SELECT used_units value FROM resource_subpool_quota_periods WHERE id = ?`)
      .get(fixture.periodId) as { value: number }).value),
    memberUsed: asInt((db.prepare(`SELECT used_units value FROM resource_member_quotas WHERE id = ?`)
      .get(fixture.memberQuotaId) as { value: number }).value),
  };

  const report = {
    phase: 'result',
    success: responseStatus >= 200 && responseStatus < 300,
    httpStatus: responseStatus,
    selectedAccount: { id: selected.id, label: selected.label },
    routedAccount: dispatch ? { id: dispatch.accountId, matchesBinding: dispatch.accountId === selected.id } : null,
    model: dispatch?.modelId ?? request?.modelId ?? null,
    responseText: responseBody?.choices?.[0]?.message?.content ?? null,
    responseUsage: responseBody?.usage ?? null,
    resourceQuota: {
      reservation,
      subpoolUsedBefore: before.subpoolUsed,
      subpoolUsedAfter: after.subpoolUsed,
      subpoolDeducted: after.subpoolUsed - before.subpoolUsed,
      memberUsedBefore: before.memberUsed,
      memberUsedAfter: after.memberUsed,
      memberDeducted: after.memberUsed - before.memberUsed,
    },
    wallet: {
      beforeMicro: before.walletMicro,
      afterMicro: after.walletMicro,
      deductedMicro: before.walletMicro - after.walletMicro,
    },
    request,
    usage,
    dispatch,
    error: responseStatus >= 200 && responseStatus < 300 ? null : responseBody?.error ?? responseBody,
    fixture: { runId, subpoolId: fixture.subpoolId, kept: keepFixture },
  };
  console.log(JSON.stringify(report, null, 2));

  if (!keepFixture) {
    db.transaction(() => {
      db.prepare(`DELETE FROM resource_subpools WHERE id = ?`).run(fixture.subpoolId);
      db.prepare(`DELETE FROM users WHERE id = ?`).run(fixture.userId);
    })();
  }

  if (!report.success) process.exitCode = 1;
  else if (!dispatch || dispatch.accountId !== selected.id) throw new Error('Router did not use the dedicated binding');
  else if (!usage || usage.success !== 1) throw new Error('Successful Codex usage record was not generated');
  else if (after.subpoolUsed <= before.subpoolUsed || after.memberUsed <= before.memberUsed) throw new Error('Resource quota was not deducted');
  else if (after.walletMicro !== before.walletMicro) throw new Error('Wallet balance changed during resource request');
}

main().catch((error) => {
  console.error(JSON.stringify({ phase: 'fatal', error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
