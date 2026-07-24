import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_admin_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      subpool_id INTEGER REFERENCES resource_subpools(id) ON DELETE SET NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_resource_admin_audit_created
      ON resource_admin_audit_logs(created_at, id);
    CREATE INDEX IF NOT EXISTS idx_resource_admin_audit_admin
      ON resource_admin_audit_logs(admin_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_resource_admin_audit_subpool
      ON resource_admin_audit_logs(subpool_id, created_at);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_resource_admin_audit_subpool;
    DROP INDEX IF EXISTS idx_resource_admin_audit_admin;
    DROP INDEX IF EXISTS idx_resource_admin_audit_created;
    DROP TABLE IF EXISTS resource_admin_audit_logs;
  `);
}
