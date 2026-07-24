import type { Db } from '../db/types.js';

export type ResourceAlertSeverity = 'warning' | 'critical';

export function raiseResourceAlert(db: Db, input: {
  severity: ResourceAlertSeverity;
  alertType: string;
  sourceType: string;
  sourceId: string | number;
  subpoolId?: number | null;
  message: string;
  details?: Record<string, unknown>;
}): number {
  const sourceId = String(input.sourceId);
  const details = JSON.stringify(input.details ?? {});
  const existing = db.prepare(`SELECT id FROM resource_operational_alerts
    WHERE alert_type = ? AND source_type = ? AND source_id = ? AND status = 'open'`).get(
    input.alertType, input.sourceType, sourceId,
  ) as { id: number } | undefined;
  if (existing) {
    db.prepare(`UPDATE resource_operational_alerts SET severity = ?, subpool_id = COALESCE(?, subpool_id),
      message = ?, details_json = ?, occurrence_count = occurrence_count + 1,
      last_seen_at = datetime('now') WHERE id = ?`).run(
      input.severity, input.subpoolId ?? null, input.message, details, existing.id,
    );
    return existing.id;
  }
  return Number(db.prepare(`INSERT INTO resource_operational_alerts
    (severity, alert_type, source_type, source_id, subpool_id, message, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    input.severity, input.alertType, input.sourceType, sourceId,
    input.subpoolId ?? null, input.message, details,
  ).lastInsertRowid);
}

export function listResourceAlerts(db: Db, status: 'open' | 'resolved' = 'open', limit = 100) {
  return db.prepare(`SELECT id, severity, alert_type alertType, source_type sourceType,
    source_id sourceId, subpool_id subpoolId, message, details_json detailsJson,
    status, occurrence_count occurrenceCount, first_seen_at firstSeenAt,
    last_seen_at lastSeenAt, resolved_at resolvedAt, resolved_by resolvedBy
    FROM resource_operational_alerts WHERE status = ?
    ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, datetime(last_seen_at) DESC
    LIMIT ?`).all(status, Math.max(1, Math.min(500, Math.trunc(limit))));
}

export function resolveResourceAlert(db: Db, alertId: number, adminId: number): boolean {
  return db.prepare(`UPDATE resource_operational_alerts SET status = 'resolved',
    resolved_at = datetime('now'), resolved_by = ? WHERE id = ? AND status = 'open'`)
    .run(adminId, alertId).changes === 1;
}
