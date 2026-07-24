import type { Db } from '../db/types.js';

export function recordResourceAdminAudit(db: Db, input: {
  adminUserId: number;
  action: string;
  targetType: string;
  targetId?: string | number | null;
  subpoolId?: number | null;
  details?: Record<string, unknown>;
}): number {
  const result = db.prepare(`INSERT INTO resource_admin_audit_logs
    (admin_user_id, action, target_type, target_id, subpool_id, details_json)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
      input.adminUserId,
      input.action,
      input.targetType,
      input.targetId == null ? null : String(input.targetId),
      input.subpoolId ?? null,
      JSON.stringify(input.details ?? {}),
    );
  return Number(result.lastInsertRowid);
}

export function listResourceAdminAuditLogs(db: Db, input: { subpoolId?: number; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
  return db.prepare(`SELECT l.id, l.admin_user_id adminUserId, u.email adminEmail,
    l.action, l.target_type targetType, l.target_id targetId, l.subpool_id subpoolId,
    l.details_json detailsJson, l.created_at createdAt
    FROM resource_admin_audit_logs l
    LEFT JOIN users u ON u.id = l.admin_user_id
    WHERE (? IS NULL OR l.subpool_id = ?)
    ORDER BY l.id DESC LIMIT ?`).all(input.subpoolId ?? null, input.subpoolId ?? null, limit);
}
