import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_operational_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
      alert_type TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      subpool_id INTEGER REFERENCES resource_subpools(id) ON DELETE SET NULL,
      message TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_alert_open_source
      ON resource_operational_alerts(alert_type, source_type, source_id)
      WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_resource_alert_status_seen
      ON resource_operational_alerts(status, last_seen_at DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_resource_alert_status_seen;
    DROP INDEX IF EXISTS idx_resource_alert_open_source;
    DROP TABLE IF EXISTS resource_operational_alerts;
  `);
}
