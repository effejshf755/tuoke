import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { createResourceOrder } from '../../services/resource-orders.js';
import { createResourceProduct, publishResourceProduct } from '../../services/resource-products.js';
import { groupPaidResourceOrder, markResourceOrderPaidForGrouping } from '../../services/resource-grouping.js';
import { activateSubpool, stageSubpoolCodexAccount } from '../../services/resource-subpool-activation.js';
import {
  adjustResourceMemberQuota,
  getResourceMemberQuota,
  getResourceSubpoolDetail,
  listAvailableCodexAccounts,
  listResourceProductStats,
  listResourceSubpools,
  listResourceUsageRecords,
} from '../../services/resource-admin-operations.js';
import { listResourceAdminAuditLogs } from '../../services/resource-admin-audit.js';

describe('resource admin operations', () => {
  let db: Database.Database;
  let adminId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrationsSync(db, 'up');
    adminId = Number(db.prepare(`INSERT INTO users (email, password_hash, role) VALUES ('resource-admin@example.com', 'x', 'admin')`).run().lastInsertRowid);
  });
  afterEach(() => db.close());

  function account(label: string): number {
    return Number(db.prepare(`INSERT INTO codex_oauth_accounts (
      label, access_token_encrypted, access_token_iv, access_token_auth_tag,
      refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag,
      enabled, status, quota_remaining_percent, resource_scope
    ) VALUES (?, 'x', 'x', 'x', 'x', 'x', 'x', 1, 'healthy', 100, 'resource_subpool')`).run(label).lastInsertRowid);
  }

  function activePool() {
    const product = publishResourceProduct(db, createResourceProduct(db, {
      productKey: 'admin-ops', name: 'Admin operations product', priceMicro: 1_000_000,
      memberLimit: 4, durationValue: 1, durationUnit: 'month',
      totalQuotaUnits: 1_000_000, memberQuotaUnits: 250_000, groupTimeoutMinutes: 1_440,
    }).id);
    let subpoolId = 0;
    for (let index = 0; index < 4; index += 1) {
      const userId = Number(db.prepare(`INSERT INTO users (email, password_hash) VALUES (?, 'x')`).run(`ops-${index}@example.com`).lastInsertRowid);
      const order = createResourceOrder(db, userId, product.id);
      markResourceOrderPaidForGrouping(db, order.id);
      subpoolId = groupPaidResourceOrder(db, order.id).subpoolId;
    }
    const accountId = account('bound');
    stageSubpoolCodexAccount(db, subpoolId, accountId, adminId);
    activateSubpool(db, subpoolId, adminId);
    const member = db.prepare(`SELECT id FROM resource_subpool_members WHERE subpool_id = ? ORDER BY id LIMIT 1`).get(subpoolId) as { id: number };
    return { productId: product.id, subpoolId, accountId, memberId: member.id };
  }

  it('returns product, subpool, detail, account and member quota aggregates', () => {
    const seeded = activePool();
    const freeAccountId = account('available');
    const products = listResourceProductStats(db) as any[];
    expect(products.find((row) => row.id === seeded.productId)).toMatchObject({ orderCount: 4, activeOrderCount: 4, subpoolCount: 1, activeSubpoolCount: 1 });
    expect(listResourceSubpools(db, 'active')).toHaveLength(1);
    const detail = getResourceSubpoolDetail(db, seeded.subpoolId)!;
    expect((detail.members as any[])).toHaveLength(4);
    expect((detail.pool as any).accountId).toBe(seeded.accountId);
    expect((detail.pool as any)).toMatchObject({ memberLimit: 4, productId: seeded.productId });
    expect(getResourceMemberQuota(db, seeded.subpoolId, seeded.memberId)).toMatchObject({ allocationUnits: 250_000, remainingUnits: 250_000 });
    const accounts = listAvailableCodexAccounts(db) as any[];
    expect(accounts.some((row) => row.id === seeded.accountId)).toBe(false);
    expect(accounts.some((row) => row.id === freeAccountId)).toBe(true);
  });

  it('adjusts member quota with a ledger row and audit record in one transaction', () => {
    const seeded = activePool();
    const adjusted = adjustResourceMemberQuota(db, {
      subpoolId: seeded.subpoolId, memberId: seeded.memberId,
      deltaUnits: -10_000, reason: 'manual correction', adminId,
    });
    expect(adjusted).toMatchObject({ allocationUnits: 240_000, remainingUnits: 240_000 });
    const ledger = db.prepare(`SELECT delta_units delta, reason FROM resource_quota_ledger WHERE id = ?`).get(adjusted.ledgerId);
    expect(ledger).toEqual({ delta: -10_000, reason: 'manual correction' });
    const audits = listResourceAdminAuditLogs(db, { subpoolId: seeded.subpoolId }) as any[];
    expect(audits.some((row) => row.action === 'member_quota_adjusted')).toBe(true);

    expect(() => adjustResourceMemberQuota(db, {
      subpoolId: seeded.subpoolId, memberId: seeded.memberId,
      deltaUnits: 20_000, reason: 'would exceed pool', adminId,
    })).toThrow(/exceed/);
    expect((db.prepare(`SELECT allocation_units allocation FROM resource_member_quotas WHERE member_id = ?`).get(seeded.memberId) as any).allocation).toBe(240_000);
  });

  it('queries Codex usage through the member quota reservation chain', () => {
    const seeded = activePool();
    const quota = db.prepare(`SELECT q.id quotaId, p.id periodId FROM resource_member_quotas q JOIN resource_subpool_quota_periods p ON p.id = q.subpool_period_id WHERE q.member_id = ?`).get(seeded.memberId) as { quotaId: number; periodId: number };
    const requestId = Number(db.prepare(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens) VALUES ('openai-codex', 'gpt-test', ?, 'success', 10, 5)`).run(-seeded.accountId).lastInsertRowid);
    db.prepare(`INSERT INTO resource_quota_reservations
      (request_correlation_id, subpool_id, period_id, member_quota_id, reserved_units, actual_units, request_id, status, expires_at, settled_at)
      VALUES ('admin-usage-test', ?, ?, ?, 20, 15, ?, 'settled', datetime('now'), datetime('now'))`).run(seeded.subpoolId, quota.periodId, quota.quotaId, requestId);
    db.prepare(`INSERT INTO codex_usage_records
      (account_id, account_label, model_id, request_id, input_tokens, output_tokens, total_tokens, success, billing_status)
      VALUES (?, 'bound', 'gpt-test', ?, 10, 5, 15, 1, 'free')`).run(seeded.accountId, requestId);
    const records = listResourceUsageRecords(db, { subpoolId: seeded.subpoolId, memberId: seeded.memberId }) as any[];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ requestId, memberId: seeded.memberId, totalTokens: 15, quotaUnits: 15 });
  });
});
