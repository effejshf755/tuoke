import { getDb } from '../db/index.js';
import type { Scheduler } from '../lib/scheduler.js';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;

function retentionDays(): number {
  const value = Number(process.env.RECHARGE_ORDER_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_RETENTION_DAYS;
}

export function cleanupOldRechargeOrders(): number {
  const result = getDb().prepare(`
    DELETE FROM recharge_orders
    WHERE status IN ('paid', 'cancelled', 'expired')
      AND created_at < datetime('now', '-' || ? || ' days')
  `).run(retentionDays());

  if (result.changes > 0) {
    console.log(`[recharge-cleanup] deleted ${result.changes} orders older than ${retentionDays()} days`);
  }
  return result.changes;
}

export function startRechargeOrderCleanup(scheduler: Scheduler): void {
  cleanupOldRechargeOrders();
  scheduler.every(CLEANUP_INTERVAL_MS, () => { cleanupOldRechargeOrders(); }, { name: 'recharge-order-cleanup' });
}
