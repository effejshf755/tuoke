import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { createResourceOrder } from '../../services/resource-orders.js';
import { createResourceProduct, publishResourceProduct } from '../../services/resource-products.js';
import { groupPaidResourceOrder, markResourceOrderPaidForGrouping } from '../../services/resource-grouping.js';
import { activateSubpool, clearStagedSubpoolCodexAccount, stageSubpoolCodexAccount } from '../../services/resource-subpool-activation.js';
import { createConsumerApiKey } from '../../services/consumer-api-keys.js';

describe('resource subpool activation', () => {
  let db: Database.Database;
  let adminId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrationsSync(db, 'up');
    adminId = Number(db.prepare(`INSERT INTO users (email, password_hash, role) VALUES ('admin@example.com', 'x', 'admin')`).run().lastInsertRowid);
  });

  afterEach(() => db.close());

  function createAccount(label: string, remainingPercent = 100): number {
    return Number(db.prepare(`INSERT INTO codex_oauth_accounts (
      label, access_token_encrypted, access_token_iv, access_token_auth_tag,
      refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag,
      enabled, status, quota_remaining_percent, quota_reset_at, resource_scope
    ) VALUES (?, 'x', 'x', 'x', 'x', 'x', 'x', 1, 'healthy', ?, datetime('now', '+7 days'), 'resource_subpool')`).run(label, remainingPercent).lastInsertRowid);
  }

  function createFormedSubpool(withKeys = true): { subpoolId: number; productId: number } {
    const product = publishResourceProduct(db, createResourceProduct(db, {
      productKey: `activation-${Math.random()}`,
      name: 'Codex activation product',
      priceMicro: 20_000_000,
      memberLimit: 4,
      durationValue: 1,
      durationUnit: 'month',
      totalQuotaUnits: 1_000_000,
      memberQuotaUnits: 250_000,
      groupTimeoutMinutes: 10_080,
    }).id);
    let subpoolId = 0;
    for (let index = 1; index <= 4; index += 1) {
      const userId = Number(db.prepare(`INSERT INTO users (email, password_hash) VALUES (?, 'x')`).run(`activation-${product.id}-${index}@example.com`).lastInsertRowid);
      if (withKeys) createConsumerApiKey(db, userId, `Codex ${index}`, null, 'resource_subpool');
      const order = createResourceOrder(db, userId, product.id);
      markResourceOrderPaidForGrouping(db, order.id);
      subpoolId = groupPaidResourceOrder(db, order.id).subpoolId;
    }
    return { subpoolId, productId: product.id };
  }

  it('activates a complete four-person subpool atomically', () => {
    const { subpoolId } = createFormedSubpool();
    const accountId = createAccount('activation-account');
    stageSubpoolCodexAccount(db, subpoolId, accountId);

    const result = activateSubpool(db, subpoolId, adminId);
    expect(result.status).toBe('active');
    expect(result.accountId).toBe(accountId);
    expect(result.allocationUnits).toBe(1_000_000);
    expect(result.memberAllocations).toHaveLength(4);
    expect(result.memberAllocations.every((quota) => quota.allocationUnits === 250_000)).toBe(true);
    const pool = db.prepare(`SELECT status, pending_codex_account_id pendingAccount, activated_by_admin_id admin FROM resource_subpools WHERE id = ?`).get(subpoolId);
    expect(pool).toEqual({ status: 'active', pendingAccount: null, admin: adminId });
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_bindings WHERE subpool_id = ? AND status = 'active'`).get(subpoolId) as { count: number }).count).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_quota_ledger WHERE subpool_id = ? AND type = 'reset'`).get(subpoolId) as { count: number }).count).toBe(4);
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_members WHERE subpool_id = ? AND consumer_api_key_id IS NOT NULL`).get(subpoolId) as { count: number }).count).toBe(4);
  });

  it('allows an administrator to clear a staged account before activation', () => {
    const { subpoolId } = createFormedSubpool();
    const accountId = createAccount('clear-staged', 100);
    stageSubpoolCodexAccount(db, subpoolId, accountId, adminId);
    clearStagedSubpoolCodexAccount(db, subpoolId, adminId);
    expect(db.prepare(`SELECT pending_codex_account_id pending FROM resource_subpools WHERE id = ?`).get(subpoolId))
      .toEqual({ pending: null });
    expect(db.prepare(`SELECT action FROM resource_admin_audit_logs WHERE subpool_id = ? ORDER BY id DESC LIMIT 1`).get(subpoolId))
      .toEqual({ action: 'codex_account_stage_cleared' });
  });

  it('uses the entitlement frozen at grouping after the product row changes', () => {
    const { subpoolId, productId } = createFormedSubpool();
    db.prepare(`UPDATE resource_products
      SET total_quota_units = 800000, member_quota_units = 200000, meter_version = 'changed-v2'
      WHERE id = ?`).run(productId);
    const accountId = createAccount('frozen-entitlement-account');
    stageSubpoolCodexAccount(db, subpoolId, accountId);

    const result = activateSubpool(db, subpoolId, adminId);
    expect(result.allocationUnits).toBe(1_000_000);
    expect(result.memberAllocations.every((quota) => quota.allocationUnits === 250_000)).toBe(true);
    expect(db.prepare(`SELECT allocation_units allocation, meter_version meterVersion
      FROM resource_subpool_quota_periods WHERE id = ?`).get(result.quotaPeriodId)).toEqual({
      allocation: 1_000_000,
      meterVersion: 'tokens-v1',
    });
  });

  it('allows activation before members create their Codex pool API keys', () => {
    const { subpoolId } = createFormedSubpool(false);
    const accountId = createAccount('missing-key-account');
    stageSubpoolCodexAccount(db, subpoolId, accountId);

    expect(activateSubpool(db, subpoolId, adminId).status).toBe('active');
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_bindings WHERE subpool_id = ?`).get(subpoolId) as { count: number }).count).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_members WHERE subpool_id = ? AND consumer_api_key_id IS NULL`).get(subpoolId) as { count: number }).count).toBe(4);
  });

  it('allows an administrator to activate with a zero-quota account', () => {
    const { subpoolId } = createFormedSubpool();
    const accountId = createAccount('zero-quota-account', 0);
    stageSubpoolCodexAccount(db, subpoolId, accountId);

    expect(activateSubpool(db, subpoolId, adminId).status).toBe('active');
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_bindings WHERE subpool_id = ?`).get(subpoolId) as { count: number }).count).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_quota_periods WHERE subpool_id = ?`).get(subpoolId) as { count: number }).count).toBe(1);
  });

  it('rejects activation when the member count is below the product limit and rolls back', () => {
    const { subpoolId } = createFormedSubpool();
    const member = db.prepare(`SELECT id, resource_order_id orderId FROM resource_subpool_members WHERE subpool_id = ? ORDER BY id DESC LIMIT 1`).get(subpoolId) as { id: number; orderId: number };
    db.prepare(`DELETE FROM resource_subpool_members WHERE id = ?`).run(member.id);
    db.prepare(`UPDATE resource_orders SET subpool_id = NULL, order_status = 'paid_waiting_group' WHERE id = ?`).run(member.orderId);
    const accountId = createAccount('short-account');
    stageSubpoolCodexAccount(db, subpoolId, accountId);

    expect(() => activateSubpool(db, subpoolId, adminId)).toThrow(/member count/);
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_bindings WHERE subpool_id = ?`).get(subpoolId) as { count: number }).count).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_quota_periods WHERE subpool_id = ?`).get(subpoolId) as { count: number }).count).toBe(0);
  });

  it('rejects an account already bound to another dedicated subpool', () => {
    const first = createFormedSubpool();
    const second = createFormedSubpool();
    const accountId = createAccount('shared-account');
    db.prepare(`INSERT INTO resource_subpool_bindings (subpool_id, codex_account_id, status) VALUES (?, ?, 'active')`).run(first.subpoolId, accountId);
    expect(() => stageSubpoolCodexAccount(db, second.subpoolId, accountId)).toThrow(/cannot be staged/);
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_quota_periods WHERE subpool_id = ?`).get(second.subpoolId) as { count: number }).count).toBe(0);
  });

  it('rejects repeated activation without creating duplicate quotas', () => {
    const { subpoolId } = createFormedSubpool();
    const accountId = createAccount('repeat-account');
    stageSubpoolCodexAccount(db, subpoolId, accountId);
    activateSubpool(db, subpoolId, adminId);

    expect(() => activateSubpool(db, subpoolId, adminId)).toThrow(/waiting_resource/);
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_subpool_quota_periods WHERE subpool_id = ?`).get(subpoolId) as { count: number }).count).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) count FROM resource_member_quotas q JOIN resource_subpool_quota_periods p ON p.id = q.subpool_period_id WHERE p.subpool_id = ?`).get(subpoolId) as { count: number }).count).toBe(4);
  });
});
