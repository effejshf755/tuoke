import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { createConsumerApiKey } from '../../services/consumer-api-keys.js';
import { createResourceProduct, publishResourceProduct } from '../../services/resource-products.js';
import { purchaseResourceProduct } from '../../services/resource-purchase.js';
import { releaseSubpoolQuota, reserveSubpoolQuota, ResourceQuotaError } from '../../services/resource-quota.js';
import { activateSubpool, stageSubpoolCodexAccount } from '../../services/resource-subpool-activation.js';
import {
  changeResourceSubpoolAccount,
  pauseResourceSubpool,
  resumeResourceSubpool,
  unbindResourceSubpoolAccount,
} from '../../services/resource-subpool-operations.js';

describe('resource subpool operations', () => {
  let db: Database.Database;
  let adminId: number;
  let sequence: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrationsSync(db, 'up');
    adminId = Number(db.prepare(`INSERT INTO users (email, password_hash, role)
      VALUES ('operations-admin@example.com', 'x', 'admin')`).run().lastInsertRowid);
    sequence = 0;
  });

  afterEach(() => db.close());

  function account(label: string): number {
    return Number(db.prepare(`INSERT INTO codex_oauth_accounts (
      label, access_token_encrypted, access_token_iv, access_token_auth_tag,
      refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag,
      enabled, status, quota_remaining_percent, quota_reset_at, resource_scope
    ) VALUES (?, 'x', 'x', 'x', 'x', 'x', 'x', 1, 'healthy', 100, datetime('now', '+30 days'), 'resource_subpool')`).run(label).lastInsertRowid);
  }

  function activePool(label: string, accountId = account(`${label}-account`)) {
    sequence += 1;
    const product = publishResourceProduct(db, createResourceProduct(db, {
      productKey: `${label}-${sequence}`,
      name: label,
      priceMicro: 10_000_000,
      memberLimit: 2,
      durationValue: 1,
      durationUnit: 'month',
      totalQuotaUnits: 1_000_000,
      memberQuotaUnits: 500_000,
      groupTimeoutMinutes: 10_080,
    }).id);
    const users: Array<{ userId: number; keyId: number }> = [];
    let subpoolId = 0;
    for (let index = 0; index < 2; index += 1) {
      const userId = Number(db.prepare(`INSERT INTO users (email, password_hash, balance_micro)
        VALUES (?, 'x', 20000000)`).run(`${label}-${sequence}-${index}@example.com`).lastInsertRowid);
      const keyId = createConsumerApiKey(db, userId, `Codex ${index}`, null, 'resource_subpool').record.id;
      subpoolId = purchaseResourceProduct(db, {
        userId, productId: product.id, idempotencyKey: `${label}-${sequence}-${index}`,
      }).grouping.subpoolId;
      users.push({ userId, keyId });
    }
    stageSubpoolCodexAccount(db, subpoolId, accountId);
    activateSubpool(db, subpoolId, adminId);
    return { subpoolId, accountId, users };
  }

  it('rejects new quota reservations while paused without changing entitlement balances', () => {
    const seeded = activePool('pause');
    pauseResourceSubpool(db, seeded.subpoolId, adminId);
    const before = db.prepare(`SELECT allocation_units allocation, used_units used, reserved_units reserved
      FROM resource_member_quotas ORDER BY id LIMIT 1`).get();

    expect(() => reserveSubpoolQuota(db, seeded.users[0].userId, seeded.users[0].keyId, 100))
      .toThrowError(ResourceQuotaError);
    expect(db.prepare(`SELECT allocation_units allocation, used_units used, reserved_units reserved
      FROM resource_member_quotas ORDER BY id LIMIT 1`).get()).toEqual(before);
    expect(db.prepare(`SELECT status FROM resource_subpools WHERE id = ?`).get(seeded.subpoolId)).toEqual({ status: 'paused' });
  });

  it('allows quota reservations again after resume', () => {
    const seeded = activePool('resume');
    pauseResourceSubpool(db, seeded.subpoolId, adminId);
    expect(resumeResourceSubpool(db, seeded.subpoolId, adminId).status).toBe('active');

    const reservation = reserveSubpoolQuota(db, seeded.users[0].userId, seeded.users[0].keyId, 100);
    expect(reservation.subpoolId).toBe(seeded.subpoolId);
    releaseSubpoolQuota(db, reservation.reservationId);
    const actions = db.prepare(`SELECT action FROM resource_admin_audit_logs
      WHERE subpool_id = ? ORDER BY id`).all(seeded.subpoolId) as Array<{ action: string }>;
    expect(actions.map((row) => row.action)).toEqual(expect.arrayContaining(['subpool_paused', 'subpool_resumed']));
  });

  it('atomically replaces the dedicated account binding', () => {
    const seeded = activePool('change');
    const replacementId = account('replacement-account');
    const changed = changeResourceSubpoolAccount(db, {
      subpoolId: seeded.subpoolId, accountId: replacementId, adminId,
    });

    expect(changed).toMatchObject({ previousAccountId: seeded.accountId, accountId: replacementId });
    expect(db.prepare(`SELECT codex_account_id accountId, status FROM resource_subpool_bindings
      WHERE subpool_id = ? ORDER BY id`).all(seeded.subpoolId)).toEqual([
      { accountId: seeded.accountId, status: 'released' },
      { accountId: replacementId, status: 'active' },
    ]);
    expect(db.prepare(`SELECT action FROM resource_admin_audit_logs
      WHERE subpool_id = ? AND action = 'subpool_account_changed'`).get(seeded.subpoolId)).toEqual({ action: 'subpool_account_changed' });
  });

  it('rejects an account occupied by another dedicated subpool and keeps the old binding', () => {
    const first = activePool('occupied-first');
    const second = activePool('occupied-second');

    expect(() => changeResourceSubpoolAccount(db, {
      subpoolId: first.subpoolId, accountId: second.accountId, adminId,
    })).toThrow(/already bound/);
    expect(db.prepare(`SELECT codex_account_id accountId FROM resource_subpool_bindings
      WHERE subpool_id = ? AND status = 'active'`).get(first.subpoolId)).toEqual({ accountId: first.accountId });
  });

  it('unbinds the account and pauses the subpool without changing quotas', () => {
    const seeded = activePool('unbind');
    const before = db.prepare(`SELECT allocation_units allocation FROM resource_member_quotas ORDER BY id LIMIT 1`).get();
    expect(unbindResourceSubpoolAccount(db, seeded.subpoolId, adminId)).toMatchObject({ status: 'paused', accountId: seeded.accountId });
    expect(db.prepare(`SELECT status FROM resource_subpools WHERE id = ?`).get(seeded.subpoolId)).toEqual({ status: 'paused' });
    expect(db.prepare(`SELECT status FROM resource_subpool_bindings WHERE subpool_id = ?`).get(seeded.subpoolId)).toEqual({ status: 'released' });
    expect(db.prepare(`SELECT allocation_units allocation FROM resource_member_quotas ORDER BY id LIMIT 1`).get()).toEqual(before);
  });

  it('binds a replacement account after an administrator unbinds a paused subpool', () => {
    const seeded = activePool('rebind');
    const replacementId = account('replacement-after-unbind');
    unbindResourceSubpoolAccount(db, seeded.subpoolId, adminId);

    expect(changeResourceSubpoolAccount(db, {
      subpoolId: seeded.subpoolId, accountId: replacementId, adminId,
    })).toMatchObject({ previousAccountId: null, accountId: replacementId, status: 'paused' });
    expect(db.prepare(`SELECT codex_account_id accountId, status FROM resource_subpool_bindings
      WHERE subpool_id = ? ORDER BY id`).all(seeded.subpoolId)).toEqual([
      { accountId: seeded.accountId, status: 'released' },
      { accountId: replacementId, status: 'active' },
    ]);
    expect(resumeResourceSubpool(db, seeded.subpoolId, adminId).status).toBe('active');
  });
});
