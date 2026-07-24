import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { reserveSubpoolQuota, finalizeSubpoolQuota, ResourceQuotaError } from '../../services/resource-quota.js';
import { selectCodexExecution, ResourceDispatchError } from '../../services/resource-scheduler.js';

describe('resource architecture', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrationsSync(db, 'up');
  });
  afterEach(() => db.close());

  function seed(mode: 'dedicated' | 'scheduled' = 'dedicated') {
    const userId = Number(db.prepare(`INSERT INTO users (email, password_hash) VALUES ('member@example.com', 'x')`).run().lastInsertRowid);
    const keyId = Number(db.prepare(`INSERT INTO consumer_api_keys (user_id, name, key_prefix, key_hash, key_type, key_scope) VALUES (?, 'codex', 'tuoke-test', 'hash', 'codex_pool', 'resource_subpool')`).run(userId).lastInsertRowid);
    const accountId = Number(db.prepare(`INSERT INTO codex_oauth_accounts
      (label, access_token_encrypted, access_token_iv, access_token_auth_tag, refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag, status, resource_scope)
      VALUES ('dedicated', 'x', 'x', 'x', 'x', 'x', 'x', 'healthy', 'resource_subpool')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO codex_oauth_account_models (account_id, model_id) VALUES (?, 'gpt-test')`).run(accountId);
    db.prepare(`INSERT INTO model_billing_rules (platform, model_id, input_price_micro_per_million, output_price_micro_per_million, billing_enabled)
      VALUES ('openai-codex', 'gpt-test', 0, 0, 1)`).run();
    const subpoolId = Number(db.prepare(`INSERT INTO resource_subpools (name, mode, status, member_limit) VALUES ('pool', ?, 'active', 4)`).run(mode).lastInsertRowid);
    const memberId = Number(db.prepare(`INSERT INTO resource_subpool_members (subpool_id, user_id, consumer_api_key_id, status) VALUES (?, ?, ?, 'active')`).run(subpoolId, userId, keyId).lastInsertRowid);
    const periodId = Number(db.prepare(`INSERT INTO resource_subpool_quota_periods (subpool_id, period_key, allocation_units, starts_at) VALUES (?, '2026-07', 100, datetime('now', '-1 day'))`).run(subpoolId).lastInsertRowid);
    db.prepare(`INSERT INTO resource_member_quotas (subpool_period_id, member_id, allocation_units) VALUES (?, ?, 25)`).run(periodId, memberId);
    if (mode === 'dedicated') db.prepare(`INSERT INTO resource_subpool_bindings (subpool_id, codex_account_id) VALUES (?, ?)`).run(subpoolId, accountId);
    return { userId, keyId, accountId, subpoolId };
  }

  it('reserves and settles both subpool and member quota idempotently', () => {
    const { userId, keyId } = seed();
    const reservation = reserveSubpoolQuota(db, userId, keyId, 20);
    expect(reservation.mode).toBe('dedicated');
    expect(() => reserveSubpoolQuota(db, userId, keyId, 6)).toThrowError(ResourceQuotaError);
    expect(finalizeSubpoolQuota(db, reservation.reservationId, null, 12, 'success').status).toBe('settled');
    expect(finalizeSubpoolQuota(db, reservation.reservationId, null, 12, 'success').status).toBe('already_finalized');
    const quota = db.prepare(`SELECT used_units used, reserved_units reserved FROM resource_member_quotas`).get() as any;
    expect(quota).toEqual({ used: 12, reserved: 0 });
  });

  it('selects only the dedicated account fixed to the subpool', () => {
    const seeded = seed();
    const reservation = reserveSubpoolQuota(db, seeded.userId, seeded.keyId, 5);
    const selected = selectCodexExecution(db, { subpoolId: seeded.subpoolId, reservationId: reservation.reservationId, correlationId: reservation.requestCorrelationId });
    expect(selected.accountId).toBe(seeded.accountId);
    expect(selected.modelId).toBe('gpt-test');
  });

  it('keeps scheduled schema available but execution disabled in V1', () => {
    const seeded = seed('scheduled');
    const reservation = reserveSubpoolQuota(db, seeded.userId, seeded.keyId, 5);
    expect(() => selectCodexExecution(db, { subpoolId: seeded.subpoolId, reservationId: reservation.reservationId, correlationId: reservation.requestCorrelationId }))
      .toThrowError(ResourceDispatchError);
  });
});
