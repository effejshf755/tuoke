import type { Db } from '../db/types.js';
import { recordResourceAdminAudit } from './resource-admin-audit.js';

export function pauseResourceSubpool(db: Db, subpoolId: number, adminId: number) {
  return db.transaction(() => {
    const updated = db.prepare(`UPDATE resource_subpools
      SET status = 'paused', updated_at = datetime('now')
      WHERE id = ? AND status = 'active'`).run(subpoolId);
    if (updated.changes !== 1) throw new Error('Only an active resource subpool can be paused');
    recordResourceAdminAudit(db, {
      adminUserId: adminId, action: 'subpool_paused', targetType: 'resource_subpool',
      targetId: subpoolId, subpoolId,
    });
    return { subpoolId, status: 'paused' as const };
  })();
}

export function resumeResourceSubpool(db: Db, subpoolId: number, adminId: number) {
  return db.transaction(() => {
    const binding = db.prepare(`SELECT 1 FROM resource_subpool_bindings b
      JOIN codex_oauth_accounts a ON a.id = b.codex_account_id
      WHERE b.subpool_id = ? AND b.status = 'active'
        AND a.enabled = 1 AND a.status = 'healthy'`).get(subpoolId);
    if (!binding) throw new Error('A healthy dedicated account binding is required before resume');
    const updated = db.prepare(`UPDATE resource_subpools
      SET status = 'active', updated_at = datetime('now')
      WHERE id = ? AND mode = 'dedicated' AND status = 'paused'`).run(subpoolId);
    if (updated.changes !== 1) throw new Error('Only a paused dedicated resource subpool can be resumed');
    recordResourceAdminAudit(db, {
      adminUserId: adminId, action: 'subpool_resumed', targetType: 'resource_subpool',
      targetId: subpoolId, subpoolId,
    });
    return { subpoolId, status: 'active' as const };
  })();
}

export function unbindResourceSubpoolAccount(db: Db, subpoolId: number, adminId: number) {
  return db.transaction(() => {
    const pool = db.prepare(`SELECT mode, status FROM resource_subpools WHERE id = ?`).get(subpoolId) as {
      mode: string; status: string;
    } | undefined;
    if (!pool) throw new Error('Resource subpool was not found');
    if (pool.mode !== 'dedicated' || !['active', 'paused'].includes(pool.status)) {
      throw new Error('Only an active or paused dedicated subpool account can be unbound');
    }
    const binding = db.prepare(`SELECT id, codex_account_id accountId FROM resource_subpool_bindings
      WHERE subpool_id = ? AND status = 'active'`).get(subpoolId) as { id: number; accountId: number } | undefined;
    if (!binding) throw new Error('Dedicated account binding was not found');
    db.prepare(`UPDATE resource_subpool_bindings
      SET status = 'released', released_at = datetime('now')
      WHERE id = ? AND status = 'active'`).run(binding.id);
    db.prepare(`UPDATE resource_subpools SET status = 'paused', updated_at = datetime('now')
      WHERE id = ? AND status = 'active'`).run(subpoolId);
    recordResourceAdminAudit(db, {
      adminUserId: adminId, action: 'subpool_account_unbound', targetType: 'resource_subpool',
      targetId: subpoolId, subpoolId, details: { accountId: binding.accountId },
    });
    return { subpoolId, accountId: binding.accountId, status: 'paused' as const };
  })();
}

export function changeResourceSubpoolAccount(db: Db, input: {
  subpoolId: number;
  accountId: number;
  adminId: number;
}) {
  return db.transaction(() => {
    const pool = db.prepare(`SELECT mode, status FROM resource_subpools WHERE id = ?`).get(input.subpoolId) as {
      mode: string; status: string;
    } | undefined;
    if (!pool) throw new Error('Resource subpool was not found');
    if (pool.mode !== 'dedicated' || !['active', 'paused'].includes(pool.status)) {
      throw new Error('Only an active or paused dedicated subpool account can be changed');
    }
    const oldBinding = db.prepare(`SELECT id, codex_account_id accountId FROM resource_subpool_bindings
      WHERE subpool_id = ? AND status = 'active'`).get(input.subpoolId) as { id: number; accountId: number } | undefined;
    if (!oldBinding && pool.status !== 'paused') throw new Error('Dedicated account binding was not found');
    if (oldBinding?.accountId === input.accountId) throw new Error('The new account is already bound to this subpool');
    const account = db.prepare(`SELECT id FROM codex_oauth_accounts
      WHERE id = ? AND enabled = 1 AND status = 'healthy'
        AND resource_scope = 'resource_subpool'`).get(input.accountId);
    if (!account) throw new Error('The new Codex account is not enabled and healthy');
    const occupied = db.prepare(`SELECT subpool_id subpoolId FROM resource_subpool_bindings
      WHERE codex_account_id = ? AND status IN ('active', 'migrating') LIMIT 1`).get(input.accountId) as {
        subpoolId: number;
      } | undefined;
    if (occupied) throw new Error(`The new Codex account is already bound to subpool ${occupied.subpoolId}`);

    if (oldBinding) {
      const released = db.prepare(`UPDATE resource_subpool_bindings
        SET status = 'released', released_at = datetime('now')
        WHERE id = ? AND status = 'active'`).run(oldBinding.id);
      if (released.changes !== 1) throw new Error('Dedicated account binding changed during replacement');
    }
    db.prepare(`INSERT INTO resource_subpool_bindings (subpool_id, codex_account_id, status)
      VALUES (?, ?, 'active')`).run(input.subpoolId, input.accountId);
    recordResourceAdminAudit(db, {
      adminUserId: input.adminId, action: 'subpool_account_changed', targetType: 'resource_subpool',
      targetId: input.subpoolId, subpoolId: input.subpoolId,
      details: { previousAccountId: oldBinding?.accountId ?? null, accountId: input.accountId },
    });
    return {
      subpoolId: input.subpoolId,
      previousAccountId: oldBinding?.accountId ?? null,
      accountId: input.accountId,
      status: pool.status as 'active' | 'paused',
    };
  })();
}
