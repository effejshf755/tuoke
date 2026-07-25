import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import { recordResourceAdminAudit } from './resource-admin-audit.js';

export const OFFICIAL_QUOTA_FULL_SCALE_UNITS = 1_000_000;

export interface ActivatedSubpoolResult {
  subpoolId: number;
  accountId: number;
  quotaPeriodId: number;
  allocationUnits: number;
  memberAllocations: Array<{ memberId: number; allocationUnits: number }>;
  status: 'active';
}

interface ActivationPoolRow {
  id: number;
  productId: number;
  memberLimit: number;
  status: string;
  pendingAccountId: number | null;
  durationValue: number;
  durationUnit: 'day' | 'month';
  totalQuotaUnits: number;
  memberQuotaUnits: number;
  meterVersion: string;
}

export function stageSubpoolCodexAccount(db: Db, subpoolId: number, accountId: number, adminId?: number): void {
  db.transaction(() => {
    const updated = db.prepare(`UPDATE resource_subpools
      SET pending_codex_account_id = ?, updated_at = datetime('now')
      WHERE id = ? AND mode = 'dedicated' AND status = 'waiting_resource'
        AND EXISTS (SELECT 1 FROM codex_oauth_accounts a WHERE a.id = ? AND a.enabled = 1 AND a.status = 'healthy')
        AND NOT EXISTS (
          SELECT 1 FROM resource_subpool_bindings b
          WHERE b.codex_account_id = ? AND b.status IN ('active', 'migrating') AND b.subpool_id <> ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM resource_subpools other
          WHERE other.pending_codex_account_id = ? AND other.status = 'waiting_resource' AND other.id <> ?
        )`).run(accountId, subpoolId, accountId, accountId, subpoolId, accountId, subpoolId);
    if (updated.changes !== 1) throw new Error('Account cannot be staged: subpool or account is ineligible or already reserved');
    if (adminId !== undefined) recordResourceAdminAudit(db, {
      adminUserId: adminId, action: 'codex_account_staged', targetType: 'codex_oauth_account',
      targetId: accountId, subpoolId, details: { accountId },
    });
  })();
}

export function clearStagedSubpoolCodexAccount(db: Db, subpoolId: number, adminId: number): void {
  db.transaction(() => {
    const row = db.prepare(`SELECT pending_codex_account_id accountId FROM resource_subpools
      WHERE id = ? AND mode = 'dedicated' AND status = 'waiting_resource'`).get(subpoolId) as { accountId: number | null } | undefined;
    if (!row) throw new Error('Dedicated subpool must be waiting_resource');
    if (row.accountId === null) return;
    db.prepare(`UPDATE resource_subpools SET pending_codex_account_id = NULL,
      updated_at = datetime('now') WHERE id = ? AND status = 'waiting_resource'`).run(subpoolId);
    recordResourceAdminAudit(db, {
      adminUserId: adminId, action: 'codex_account_stage_cleared', targetType: 'codex_oauth_account',
      targetId: row.accountId, subpoolId, details: { accountId: row.accountId },
    });
  })();
}

export function activateSubpool(subpoolId: number, adminId: number): ActivatedSubpoolResult;
export function activateSubpool(db: Db, subpoolId: number, adminId: number): ActivatedSubpoolResult;
export function activateSubpool(
  dbOrSubpoolId: Db | number,
  subpoolIdOrAdminId: number,
  optionalAdminId?: number,
): ActivatedSubpoolResult {
  const db = typeof dbOrSubpoolId === 'number' ? getDb() : dbOrSubpoolId;
  const subpoolId = typeof dbOrSubpoolId === 'number' ? dbOrSubpoolId : subpoolIdOrAdminId;
  const adminId = typeof dbOrSubpoolId === 'number' ? subpoolIdOrAdminId : optionalAdminId!;

  return db.transaction(() => {
    const pool = db.prepare(`SELECT s.id, s.product_id productId, s.member_limit memberLimit,
      s.status, s.pending_codex_account_id pendingAccountId,
      s.frozen_total_quota_units totalQuotaUnits,
      s.frozen_member_quota_units memberQuotaUnits,
      s.frozen_meter_version meterVersion,
      (SELECT o.duration_value_snapshot FROM resource_subpool_members m
       JOIN resource_orders o ON o.id = m.resource_order_id
       WHERE m.subpool_id = s.id ORDER BY m.id LIMIT 1) durationValue,
      (SELECT o.duration_unit_snapshot FROM resource_subpool_members m
       JOIN resource_orders o ON o.id = m.resource_order_id
       WHERE m.subpool_id = s.id ORDER BY m.id LIMIT 1) durationUnit
      FROM resource_subpools s
      WHERE s.id = ? AND s.mode = 'dedicated'`).get(subpoolId) as ActivationPoolRow | undefined;
    if (!pool) throw new Error('Dedicated resource subpool was not found');
    if (pool.status !== 'waiting_resource') throw new Error('Subpool must be waiting_resource before activation');
    if (pool.pendingAccountId === null) throw new Error('A Codex OAuth account must be selected before activation');
    if (!pool.totalQuotaUnits || !pool.memberQuotaUnits || !pool.meterVersion) {
      throw new Error('Subpool entitlement snapshot is missing');
    }

    const admin = db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'admin'`).get(adminId);
    if (!admin) throw new Error('Activating administrator was not found');

    const members = db.prepare(`SELECT m.id memberId, m.user_id userId, m.resource_order_id orderId,
      o.order_status orderStatus, o.user_id orderUserId, o.product_id orderProductId,
      o.subpool_id orderSubpoolId
      FROM resource_subpool_members m
      LEFT JOIN resource_orders o ON o.id = m.resource_order_id
      WHERE m.subpool_id = ? ORDER BY m.id`).all(subpoolId) as Array<{
        memberId: number; userId: number; orderId: number | null; orderStatus: string | null;
        orderUserId: number | null; orderProductId: number | null; orderSubpoolId: number | null;
      }>;
    if (members.length !== pool.memberLimit) throw new Error('Subpool member count does not match the product member limit');
    const invalidMember = members.find((member) => member.orderId === null
      || member.orderStatus !== 'grouped'
      || member.orderUserId !== member.userId
      || member.orderProductId !== pool.productId
      || member.orderSubpoolId !== pool.id);
    if (invalidMember) throw new Error(`Subpool member ${invalidMember.memberId} does not have a valid grouped order`);
    const account = db.prepare(`SELECT id, quota_remaining_percent remainingPercent, quota_reset_at resetAt
      FROM codex_oauth_accounts
      WHERE id = ? AND enabled = 1 AND status = 'healthy'
        AND resource_scope = 'resource_subpool'`).get(pool.pendingAccountId) as {
        id: number; remainingPercent: number | null; resetAt: string | null;
      } | undefined;
    if (!account) throw new Error('Selected Codex OAuth account is not a healthy resource-subpool account');
    const conflict = db.prepare(`SELECT subpool_id subpoolId FROM resource_subpool_bindings
      WHERE codex_account_id = ? AND status IN ('active', 'migrating') AND subpool_id <> ? LIMIT 1`).get(account.id, pool.id) as { subpoolId: number } | undefined;
    if (conflict) throw new Error(`Codex OAuth account is already bound to subpool ${conflict.subpoolId}`);
    const existingBinding = db.prepare(`SELECT 1 FROM resource_subpool_bindings WHERE subpool_id = ? AND status IN ('active', 'migrating')`).get(pool.id);
    if (existingBinding) throw new Error('Subpool already has a dedicated account binding');

    const stageOneReleasePercent = 20;
    const stageMemberUnits = Math.max(1, Math.floor(pool.memberQuotaUnits * stageOneReleasePercent / 100));
    const allocationUnits = stageMemberUnits * members.length;
    const binding = db.prepare(`INSERT INTO resource_subpool_bindings (subpool_id, codex_account_id, status)
      VALUES (?, ?, 'active')`).run(pool.id, account.id);
    if (!binding.lastInsertRowid) throw new Error('Failed to create dedicated account binding');

    const periodKey = `activation:${pool.id}:${Date.now()}`;
    const period = db.prepare(`INSERT INTO resource_subpool_quota_periods (
      subpool_id, period_key, source_type, source_account_id, allocation_units,
      starts_at, resets_at, meter_version, status
    ) VALUES (?, ?, 'official_account', ?, ?, datetime('now'), ?, ?, 'active')`).run(
      pool.id, periodKey, account.id, allocationUnits, account.resetAt, pool.meterVersion,
    );
    const quotaPeriodId = Number(period.lastInsertRowid);
    const memberAllocations: ActivatedSubpoolResult['memberAllocations'] = [];
    for (const member of members) {
      const memberUnits = stageMemberUnits;
      db.prepare(`INSERT INTO resource_member_quotas
        (subpool_period_id, member_id, allocation_units, status)
        VALUES (?, ?, ?, 'active')`).run(quotaPeriodId, member.memberId, memberUnits);
      db.prepare(`INSERT INTO resource_quota_ledger
        (subpool_id, period_id, member_id, type, delta_units, balance_after_units, reason)
        VALUES (?, ?, ?, 'reset', ?, ?, ?)`).run(
          pool.id, quotaPeriodId, member.memberId, memberUnits, memberUnits,
          `Stage one activation by admin ${adminId}; ${stageOneReleasePercent}% of ${pool.memberQuotaUnits} promised units`,
        );
      memberAllocations.push({ memberId: member.memberId, allocationUnits: memberUnits });
    }

    const durationModifier = `+${pool.durationValue} ${pool.durationUnit}${pool.durationValue === 1 ? '' : 's'}`;
    db.prepare(`UPDATE resource_subpool_members
      SET status = 'active', activated_at = datetime('now') WHERE subpool_id = ? AND status = 'waiting'`).run(pool.id);
    db.prepare(`UPDATE resource_orders SET order_status = 'active', updated_at = datetime('now')
      WHERE subpool_id = ? AND order_status = 'grouped'`).run(pool.id);
    const activated = db.prepare(`UPDATE resource_subpools
      SET status = 'active', starts_at = datetime('now'), ends_at = datetime('now', ?),
          activated_by_admin_id = ?, activated_at = datetime('now'),
          pending_codex_account_id = NULL, quota_stage = 1,
          stage_one_release_percent = ?, stage_one_floor_percent = 50,
          stage_started_official_percent = ?, stage_one_released_units = ?,
          stage_one_used_units = NULL, stage_one_completed_official_percent = NULL,
          stage_one_completed_at = NULL, stage_two_released_at = NULL,
          stage_two_multiplier_factor_micros = 1000000,
          quota_phase = 1, phase_release_percent = 20,
          phase_started_official_percent = ?, phase_started_used_units = 0,
          phase_released_units = ?, phase_multiplier_factor_micros = 1000000,
          phase_started_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ? AND status = 'waiting_resource'`).run(
        durationModifier, adminId, stageOneReleasePercent,
        account.remainingPercent ?? 100, allocationUnits,
        account.remainingPercent ?? 100, allocationUnits, pool.id,
      );
    if (activated.changes !== 1) throw new Error('Subpool state changed during activation');

    recordResourceAdminAudit(db, {
      adminUserId: adminId, action: 'subpool_activated', targetType: 'resource_subpool',
      targetId: pool.id, subpoolId: pool.id,
      details: { accountId: account.id, quotaPeriodId, allocationUnits, memberCount: members.length },
    });

    return { subpoolId: pool.id, accountId: account.id, quotaPeriodId, allocationUnits, memberAllocations, status: 'active' as const };
  })();
}
