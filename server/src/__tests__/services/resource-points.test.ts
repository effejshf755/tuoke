import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { getResourcePointsPolicy, updateResourcePointsPolicy } from '../../services/resource-points.js';
import {
  calculateResourcePoints,
  estimateCodexQuotaUnits,
  finalizeSubpoolQuota,
  reserveSubpoolQuota,
  ResourceQuotaError,
} from '../../services/resource-quota.js';

describe('resource points policy', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrationsSync(db, 'up');
  });
  afterEach(() => db.close());

  function seed(officialRemainingPercent: number | null = 100) {
    const userId = Number(db.prepare(`INSERT INTO users (email, password_hash) VALUES ('points@example.com', 'x')`).run().lastInsertRowid);
    const keyId = Number(db.prepare(`INSERT INTO consumer_api_keys
      (user_id, name, key_prefix, key_hash, key_type, key_scope)
      VALUES (?, 'points', 'tuoke-points', 'hash', 'codex_pool', 'resource_subpool')`).run(userId).lastInsertRowid);
    const accountId = Number(db.prepare(`INSERT INTO codex_oauth_accounts
      (label, access_token_encrypted, access_token_iv, access_token_auth_tag,
       refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag, status,
       resource_scope, quota_remaining_percent, quota_reset_at)
      VALUES ('points', 'x', 'x', 'x', 'x', 'x', 'x', 'healthy', 'resource_subpool', ?, datetime('now', '+7 days'))`)
      .run(officialRemainingPercent).lastInsertRowid);
    const subpoolId = Number(db.prepare(`INSERT INTO resource_subpools
      (name, mode, status, member_limit, starts_at, ends_at)
      VALUES ('points', 'dedicated', 'active', 1, datetime('now', '-1 day'), datetime('now', '+1 month'))`).run().lastInsertRowid);
    const memberId = Number(db.prepare(`INSERT INTO resource_subpool_members
      (subpool_id, user_id, consumer_api_key_id, status) VALUES (?, ?, ?, 'active')`).run(subpoolId, userId, keyId).lastInsertRowid);
    const periodId = Number(db.prepare(`INSERT INTO resource_subpool_quota_periods
      (subpool_id, period_key, allocation_units, starts_at) VALUES (?, 'points', 100000, datetime('now', '-1 day'))`).run(subpoolId).lastInsertRowid);
    db.prepare(`INSERT INTO resource_member_quotas (subpool_period_id, member_id, allocation_units)
      VALUES (?, ?, 100000)`).run(periodId, memberId);
    db.prepare(`INSERT INTO resource_subpool_bindings (subpool_id, codex_account_id) VALUES (?, ?)`).run(subpoolId, accountId);
    return { userId, keyId, accountId };
  }

  it('calculates separate input and output weights with ceiling', () => {
    expect(calculateResourcePoints(1000, 500, 1_000_000, 2_000_000)).toBe(2000);
    expect(calculateResourcePoints(1, 0, 1_500_000, 1_000_000)).toBe(2);
    expect(calculateResourcePoints(1000, 500, 1_000_000, 2_000_000, 400, 250_000)).toBe(1700);
  });

  it('uses model-specific rules and snapshots them for settlement', () => {
    const seedData = seed();
    updateResourcePointsPolicy(db, {
      officialQuotaFloorPercent: 2,
      defaultInputMultiplier: 1,
      defaultOutputMultiplier: 1,
      models: [{ modelId: 'gpt-weighted', inputMultiplier: 1, cachedInputMultiplier: 0.25, outputMultiplier: 2 }],
    });
    const estimate = estimateCodexQuotaUnits(db, { model: 'gpt-weighted', input: 'hello', max_output_tokens: 10 });
    expect(estimate.inputMultiplierMicros).toBe(1_000_000);
    expect(estimate.cachedInputMultiplierMicros).toBe(250_000);
    expect(estimate.outputMultiplierMicros).toBe(2_000_000);
    const reservation = reserveSubpoolQuota(db, seedData.userId, seedData.keyId, estimate);

    updateResourcePointsPolicy(db, {
      officialQuotaFloorPercent: 2,
      defaultInputMultiplier: 1,
      defaultOutputMultiplier: 1,
      models: [{ modelId: 'gpt-weighted', inputMultiplier: 9, cachedInputMultiplier: 9, outputMultiplier: 9 }],
    });
    finalizeSubpoolQuota(db, reservation.reservationId, null, { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 500 }, 'success');
    const settled = db.prepare(`SELECT actual_units actual, input_multiplier_micros inputMultiplier,
      cached_input_tokens cachedInputTokens, cached_input_multiplier_micros cachedInputMultiplier,
      output_multiplier_micros outputMultiplier FROM resource_quota_reservations WHERE id = ?`)
      .get(reservation.reservationId);
    expect(settled).toEqual({ actual: 1700, inputMultiplier: 1_000_000, cachedInputTokens: 400,
      cachedInputMultiplier: 250_000, outputMultiplier: 2_000_000 });
  });

  it('charges weighted actual usage for a partial stream and releases failures before usage', () => {
    const seedData = seed();
    const weighted = { modelId: 'gpt-partial', inputTokens: 10, outputTokens: 100,
      inputMultiplierMicros: 1_000_000, outputMultiplierMicros: 3_000_000, units: 310 };
    const partial = reserveSubpoolQuota(db, seedData.userId, seedData.keyId, weighted);
    finalizeSubpoolQuota(db, partial.reservationId, null, { inputTokens: 4, outputTokens: 5 }, 'partial');
    const failed = reserveSubpoolQuota(db, seedData.userId, seedData.keyId, weighted);
    finalizeSubpoolQuota(db, failed.reservationId, null, null, 'failed_before_usage');
    expect(db.prepare(`SELECT used_units used, reserved_units reserved FROM resource_member_quotas`).get())
      .toEqual({ used: 19, reserved: 0 });
  });

  it('blocks new reservations at the official protection line', () => {
    const seedData = seed(2);
    expect(() => reserveSubpoolQuota(db, seedData.userId, seedData.keyId, 1))
      .toThrowError(ResourceQuotaError);
  });

  it('keeps defaults and validates policy updates', () => {
    expect(getResourcePointsPolicy(db).policy).toMatchObject({
      officialQuotaFloorPercent: 2,
      defaultInputMultiplier: 1,
      defaultCachedInputMultiplier: 0.25,
      defaultOutputMultiplier: 1,
    });
    expect(() => updateResourcePointsPolicy(db, {
      officialQuotaFloorPercent: 101, defaultInputMultiplier: 1, defaultOutputMultiplier: 1,
    })).toThrow(/between 0 and 100/);
  });
});
