import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import type { Scheduler } from '../lib/scheduler.js';
import { refundTimedOutResourcePurchase, ResourcePurchaseError } from './resource-purchase.js';
import { releaseSubpoolQuota } from './resource-quota.js';
import { raiseResourceAlert } from './resource-alerts.js';

const RESOURCE_MAINTENANCE_INTERVAL_MS = 60_000;
const OFFICIAL_QUOTA_FULL_SCALE_UNITS = 1_000_000;

export interface ResourceMaintenanceResult {
  releasedReservations: number;
  resetPeriods: number;
  refundedOrders: number;
  expiredSubpools: number;
}

export function releaseExpiredResourceReservations(db: Db): number {
  const rows = db.prepare(`SELECT id FROM resource_quota_reservations
    WHERE status = 'reserved' AND datetime(expires_at) <= datetime('now')
    ORDER BY id`).all() as Array<{ id: number }>;
  let released = 0;
  for (const row of rows) {
    if (releaseSubpoolQuota(db, row.id).status === 'failed') released += 1;
  }
  return released;
}

export function resetDueResourceQuotaPeriods(db: Db): number {
  const due = db.prepare(`SELECT p.id FROM resource_subpool_quota_periods p
    JOIN resource_subpools s ON s.id = p.subpool_id
    JOIN resource_subpool_bindings b ON b.subpool_id = s.id AND b.status = 'active'
    JOIN codex_oauth_accounts a ON a.id = b.codex_account_id
    WHERE p.status = 'active' AND p.resets_at IS NOT NULL
      AND datetime(p.resets_at) <= datetime('now')
      AND s.status = 'active' AND s.mode = 'dedicated'
      AND a.enabled = 1 AND a.status = 'healthy'
      AND a.quota_reset_at IS NOT NULL AND datetime(a.quota_reset_at) > datetime('now')
    ORDER BY p.id`).all() as Array<{ id: number }>;

  let reset = 0;
  for (const candidate of due) {
    const changed = db.transaction(() => {
      const row = db.prepare(`SELECT p.id periodId, p.subpool_id subpoolId,
        s.product_id productId, b.codex_account_id accountId,
        s.frozen_total_quota_units totalQuotaUnits,
        s.frozen_member_quota_units memberQuotaUnits, s.frozen_meter_version meterVersion,
        a.quota_remaining_percent remainingPercent, a.quota_reset_at nextResetAt
        FROM resource_subpool_quota_periods p
        JOIN resource_subpools s ON s.id = p.subpool_id
        JOIN resource_subpool_bindings b ON b.subpool_id = s.id AND b.status = 'active'
        JOIN codex_oauth_accounts a ON a.id = b.codex_account_id
        WHERE p.id = ? AND p.status = 'active' AND datetime(p.resets_at) <= datetime('now')
          AND s.status = 'active' AND s.mode = 'dedicated'
          AND a.enabled = 1 AND a.status = 'healthy'
          AND a.quota_reset_at IS NOT NULL AND datetime(a.quota_reset_at) > datetime('now')`).get(candidate.id) as {
            periodId: number; subpoolId: number; productId: number; accountId: number;
            totalQuotaUnits: number; memberQuotaUnits: number; meterVersion: string;
            remainingPercent: number | null; nextResetAt: string;
          } | undefined;
      if (!row || !row.totalQuotaUnits || !row.memberQuotaUnits || !row.meterVersion
        || row.remainingPercent === null || !Number.isFinite(row.remainingPercent)) return false;
      const availableUnits = Math.floor(
        Math.max(0, Math.min(100, row.remainingPercent)) * (OFFICIAL_QUOTA_FULL_SCALE_UNITS / 100),
      );
      if (availableUnits < row.totalQuotaUnits) return false;

      const reservations = db.prepare(`SELECT id FROM resource_quota_reservations
        WHERE period_id = ? AND status = 'reserved'`).all(row.periodId) as Array<{ id: number }>;
      for (const reservation of reservations) releaseSubpoolQuota(db, reservation.id);
      db.prepare(`UPDATE resource_member_quotas SET status = 'closed' WHERE subpool_period_id = ? AND status <> 'closed'`).run(row.periodId);
      db.prepare(`UPDATE resource_subpool_quota_periods
        SET status = 'closed', closed_at = datetime('now'), reserved_units = 0
        WHERE id = ? AND status = 'active'`).run(row.periodId);

      const periodKey = `official-reset:${row.accountId}:${row.nextResetAt}`;
      const inserted = db.prepare(`INSERT INTO resource_subpool_quota_periods
        (subpool_id, period_key, source_type, source_account_id, allocation_units,
         starts_at, resets_at, meter_version, status)
        VALUES (?, ?, 'product_reset', ?, ?, datetime('now'), ?, ?, 'active')`).run(
        row.subpoolId, periodKey, row.accountId, row.totalQuotaUnits, row.nextResetAt, row.meterVersion,
      );
      const periodId = Number(inserted.lastInsertRowid);
      const members = db.prepare(`SELECT id FROM resource_subpool_members
        WHERE subpool_id = ? AND status = 'active' ORDER BY id`).all(row.subpoolId) as Array<{ id: number }>;
      for (const member of members) {
        db.prepare(`INSERT INTO resource_member_quotas
          (subpool_period_id, member_id, allocation_units, status)
          VALUES (?, ?, ?, 'active')`).run(periodId, member.id, row.memberQuotaUnits);
        db.prepare(`INSERT INTO resource_quota_ledger
          (subpool_id, period_id, member_id, type, delta_units, balance_after_units, reason)
          VALUES (?, ?, ?, 'reset', ?, ?, 'scheduled official quota reset')`).run(
          row.subpoolId, periodId, member.id, row.memberQuotaUnits, row.memberQuotaUnits,
        );
      }
      return true;
    })();
    if (changed) reset += 1;
  }
  return reset;
}

export function refundTimedOutResourceGroups(db: Db): number {
  const orders = db.prepare(`SELECT o.id FROM resource_orders o
    JOIN resource_subpools s ON s.id = o.subpool_id
    WHERE o.order_status = 'paid_waiting_group' AND s.status = 'waiting_members'
      AND o.paid_at IS NOT NULL
      AND datetime(o.paid_at, '+' || o.group_timeout_minutes_snapshot || ' minutes') <= datetime('now')
    ORDER BY o.id`).all() as Array<{ id: number }>;
  let refunded = 0;
  for (const order of orders) {
    try {
      if (!refundTimedOutResourcePurchase(db, order.id).alreadyProcessed) refunded += 1;
    } catch (error) {
      if (!(error instanceof ResourcePurchaseError && error.code === 'refund_not_allowed')) throw error;
    }
  }
  db.prepare(`UPDATE resource_subpools SET status = 'expired', updated_at = datetime('now')
    WHERE status = 'waiting_members'
      AND NOT EXISTS (SELECT 1 FROM resource_subpool_members m WHERE m.subpool_id = resource_subpools.id)`).run();
  return refunded;
}

export function expireEndedResourceSubpools(db: Db): number {
  const pools = db.prepare(`SELECT id FROM resource_subpools
    WHERE status IN ('active', 'paused') AND ends_at IS NOT NULL
      AND datetime(ends_at) <= datetime('now') ORDER BY id`).all() as Array<{ id: number }>;
  let expired = 0;
  for (const pool of pools) {
    const changed = db.transaction(() => {
      const current = db.prepare(`SELECT id FROM resource_subpools WHERE id = ?
        AND status IN ('active', 'paused') AND ends_at IS NOT NULL
        AND datetime(ends_at) <= datetime('now')`).get(pool.id);
      if (!current) return false;
      const reservations = db.prepare(`SELECT id FROM resource_quota_reservations
        WHERE subpool_id = ? AND status = 'reserved'`).all(pool.id) as Array<{ id: number }>;
      for (const reservation of reservations) releaseSubpoolQuota(db, reservation.id);
      db.prepare(`UPDATE resource_member_quotas SET status = 'closed'
        WHERE subpool_period_id IN (SELECT id FROM resource_subpool_quota_periods WHERE subpool_id = ?)
          AND status <> 'closed'`).run(pool.id);
      db.prepare(`UPDATE resource_subpool_quota_periods SET status = 'expired', closed_at = datetime('now'), reserved_units = 0
        WHERE subpool_id = ? AND status = 'active'`).run(pool.id);
      db.prepare(`UPDATE resource_subpool_members SET status = 'expired', expires_at = COALESCE(expires_at, datetime('now'))
        WHERE subpool_id = ? AND status IN ('active', 'suspended')`).run(pool.id);
      db.prepare(`UPDATE resource_orders SET order_status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
        WHERE subpool_id = ? AND order_status = 'active'`).run(pool.id);
      db.prepare(`UPDATE resource_subpool_bindings SET status = 'released', released_at = datetime('now')
        WHERE subpool_id = ? AND status IN ('active', 'migrating')`).run(pool.id);
      const updated = db.prepare(`UPDATE resource_subpools SET status = 'expired', updated_at = datetime('now')
        WHERE id = ? AND status IN ('active', 'paused')`).run(pool.id);
      return updated.changes === 1;
    })();
    if (changed) expired += 1;
  }
  return expired;
}

export function runResourceMaintenance(db: Db): ResourceMaintenanceResult {
  const releasedReservations = releaseExpiredResourceReservations(db);
  const resetPeriods = resetDueResourceQuotaPeriods(db);
  const refundedOrders = refundTimedOutResourceGroups(db);
  const expiredSubpools = expireEndedResourceSubpools(db);
  return { releasedReservations, resetPeriods, refundedOrders, expiredSubpools };
}

let maintenanceStarted = false;

export function startResourceMaintenance(scheduler: Scheduler): void {
  if (maintenanceStarted) return;
  maintenanceStarted = true;
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    try {
      const result = runResourceMaintenance(getDb());
      if (Object.values(result).some((count) => count > 0)) {
        console.log('[resource-maintenance]', result);
      }
    } catch (error) {
      console.error('[resource-maintenance] failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      raiseResourceAlert(getDb(), { severity: 'critical', alertType: 'maintenance_failed',
        sourceType: 'resource_maintenance', sourceId: 'periodic', message,
        details: { error: message } });
    } finally {
      running = false;
    }
  };
  run();
  scheduler.every(RESOURCE_MAINTENANCE_INTERVAL_MS, run, { name: 'resource-maintenance' });
}
