import type { Db } from '../db/types.js';
import { decryptCodexToken } from './codex-token.js';
import { discoverCodexModels, replaceCodexAccountModels } from './codex-model-discovery.js';
import { proxyFetch } from '../lib/proxy.js';

const CODEX_USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';

export interface CodexOAuthAccount {
  id: number;
  label: string;
  account_id: string | null;
  enabled: number;
  status: string;
  last_used_at: string | null;
  last_error: string | null;
  models: string[];
  quota_used_percent: number | null;
  quota_remaining_percent: number | null;
  quota_reset_at: string | null;
  quota_synced_at: string | null;
  plan_type: string | null;
  resource_scope: 'codex_pool' | 'resource_subpool';
}

export function listCodexAccounts(db: Db): CodexOAuthAccount[] {
  const accounts = db
    .prepare(`
      SELECT
        id,
        label,
        account_id,
        enabled,
        status,
        last_used_at,
        last_error,
        quota_used_percent,
        quota_remaining_percent,
        quota_reset_at,
        quota_synced_at,
        plan_type,
        resource_scope
      FROM codex_oauth_accounts
      WHERE deleted_at IS NULL
      ORDER BY id DESC
    `)
    .all() as Array<Omit<CodexOAuthAccount, 'models'>>;

  const modelRows = db.prepare(`
    SELECT account_id, model_id
    FROM codex_oauth_account_models
    WHERE enabled = 1
    ORDER BY account_id DESC, model_id ASC
  `).all() as Array<{ account_id: number; model_id: string }>;
  const modelsByAccount = new Map<number, string[]>();
  for (const row of modelRows) {
    const models = modelsByAccount.get(row.account_id) ?? [];
    models.push(row.model_id);
    modelsByAccount.set(row.account_id, models);
  }

  return accounts.map(account => ({
    ...account,
    models: modelsByAccount.get(account.id) ?? [],
  }));
}

export function createCodexAccount(
  db: Db,
  data: {
    label: string;
    account_id?: string;
    access_token_encrypted: string;
    access_token_iv: string;
    access_token_auth_tag: string;
    refresh_token_encrypted: string;
    refresh_token_iv: string;
    refresh_token_auth_tag: string;
    token_expires_at?: string;
  },
): number {
  if (data.account_id) {
    const existing = db.prepare(`
      SELECT id
      FROM codex_oauth_accounts
      WHERE account_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(data.account_id) as { id: number } | undefined;
    if (existing) {
      db.prepare(`
        UPDATE codex_oauth_accounts
        SET label = ?,
            access_token_encrypted = ?,
            access_token_iv = ?,
            access_token_auth_tag = ?,
            refresh_token_encrypted = ?,
            refresh_token_iv = ?,
            refresh_token_auth_tag = ?,
            token_expires_at = ?,
            enabled = 0,
            status = 'unknown',
            last_error = NULL,
            failure_count = 0,
            cooldown_until = NULL,
            deleted_at = NULL,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(
        data.label,
        data.access_token_encrypted,
        data.access_token_iv,
        data.access_token_auth_tag,
        data.refresh_token_encrypted,
        data.refresh_token_iv,
        data.refresh_token_auth_tag,
        data.token_expires_at ?? null,
        existing.id,
      );
      return existing.id;
    }
  }
  const result = db.prepare(`
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
  `).run(
    data.label,
    data.account_id ?? null,
    data.access_token_encrypted,
    data.access_token_iv,
    data.access_token_auth_tag,
    data.refresh_token_encrypted,
    data.refresh_token_iv,
    data.refresh_token_auth_tag,
    data.token_expires_at ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function setCodexAccountScope(
  db: Db,
  id: number,
  scope: 'codex_pool' | 'resource_subpool',
): boolean {
  return db.transaction(() => {
    const account = db.prepare('SELECT resource_scope scope FROM codex_oauth_accounts WHERE id = ?')
      .get(id) as { scope: string } | undefined;
    if (!account) return false;
    if (account.scope === scope) return true;
    const assigned = db.prepare(`SELECT 1 FROM resource_subpool_bindings
      WHERE codex_account_id = ? AND status IN ('active', 'migrating')
      UNION ALL
      SELECT 1 FROM resource_subpools
      WHERE pending_codex_account_id = ? AND status = 'waiting_resource' LIMIT 1`).get(id, id);
    if (assigned) throw new Error('A Codex account assigned to a resource subpool cannot change scope');
    db.prepare(`UPDATE codex_oauth_accounts SET resource_scope = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(scope, id);
    return true;
  })();
}

type CodexUsagePayload = {
  plan_type?: unknown;
  rate_limit?: {
    primary_window?: {
      used_percent?: unknown;
      reset_at?: unknown;
    } | null;
  } | null;
};

async function syncCodexAccountQuota(
  db: Db,
  id: number,
  accessToken: string,
  accountId: string | null,
): Promise<void> {
  const response = await proxyFetch(
    CODEX_USAGE_ENDPOINT,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      },
    },
    'openai-codex',
  );
  if (!response.ok) throw new Error(`Codex quota sync failed with HTTP ${response.status}`);

  const payload = await response.json() as CodexUsagePayload;
  const window = payload.rate_limit?.primary_window;
  const used = Number(window?.used_percent);
  const resetAtSeconds = Number(window?.reset_at);
  const usedPercent = Number.isFinite(used) ? Math.min(100, Math.max(0, used)) : null;
  const remainingPercent = usedPercent == null ? null : Math.max(0, 100 - usedPercent);
  const resetAt = Number.isFinite(resetAtSeconds) && resetAtSeconds > 0
    ? new Date(resetAtSeconds * 1_000).toISOString()
    : null;
  const planType = typeof payload.plan_type === 'string' ? payload.plan_type.slice(0, 100) : null;

  db.prepare(`
    UPDATE codex_oauth_accounts
    SET quota_used_percent=?,
        quota_remaining_percent=?,
        quota_reset_at=?,
        quota_synced_at=datetime('now'),
        plan_type=?,
        updated_at=datetime('now')
    WHERE id=?
  `).run(usedPercent, remainingPercent, resetAt, planType, id);
}

export function deleteCodexAccount(
  db: Db,
  id: number,
): boolean {
  return db.transaction(() => {
    const account = db.prepare(`SELECT id FROM codex_oauth_accounts
      WHERE id = ? AND deleted_at IS NULL`).get(id);
    if (!account) return false;
    const activeAssignment = db.prepare(`SELECT 1 FROM resource_subpool_bindings
      WHERE codex_account_id = ? AND status IN ('active', 'migrating')
      UNION ALL
      SELECT 1 FROM resource_subpools
      WHERE pending_codex_account_id = ? AND status = 'waiting_resource' LIMIT 1`).get(id, id);
    if (activeAssignment) {
      throw new Error('Codex account is assigned to a resource subpool and cannot be deleted');
    }
    const result = db.prepare(`UPDATE codex_oauth_accounts
      SET enabled = 0, status = 'deleted', deleted_at = datetime('now'),
          cooldown_until = NULL, updated_at = datetime('now')
      WHERE id = ? AND deleted_at IS NULL`).run(id);
    return result.changes === 1;
  })();
}

export function setCodexAccountEnabled(
  db: Db,
  id: number,
  enabled: boolean,
): boolean {
  const result = db.prepare(`
    UPDATE codex_oauth_accounts
    SET enabled = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(enabled ? 1 : 0, id);
  return result.changes === 1;
}

export async function checkCodexAccountHealth(db: Db, id: number): Promise<CodexOAuthAccount> {
  const account = db.prepare(`
    SELECT id, account_id, access_token_encrypted, access_token_iv, access_token_auth_tag
    FROM codex_oauth_accounts
    WHERE id = ?
  `).get(id) as {
    id: number;
    account_id: string | null;
    access_token_encrypted: string;
    access_token_iv: string;
    access_token_auth_tag: string;
  } | undefined;
  if (!account) throw new Error('Codex OAuth account not found');

  try {
    const accessToken = decryptCodexToken(
      account.access_token_encrypted,
      account.access_token_iv,
      account.access_token_auth_tag,
    );
    const models = await discoverCodexModels(accessToken, account.account_id);
    replaceCodexAccountModels(db, id, models);
    await syncCodexAccountQuota(db, id, accessToken, account.account_id);
    db.prepare(`
      UPDATE codex_oauth_accounts
      SET status='healthy', last_error=NULL, failure_count=0,
          cooldown_until=NULL, updated_at=datetime('now')
      WHERE id=?
    `).run(id);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Codex account health check failed';
    db.prepare(`
      UPDATE codex_oauth_accounts
      SET status='unhealthy', last_error=?, failure_count=failure_count+1,
          updated_at=datetime('now')
      WHERE id=?
    `).run(message.slice(0, 2_000), id);
  }

  return listCodexAccounts(db).find(accountRow => accountRow.id === id)!;
}
