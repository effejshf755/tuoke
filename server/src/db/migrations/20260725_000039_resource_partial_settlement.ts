import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(resource_quota_reservations)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'settlement_status')) {
    db.exec(`ALTER TABLE resource_quota_reservations ADD COLUMN settlement_status TEXT
      CHECK (settlement_status IN ('failed_before_usage', 'partial', 'success'))`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_resource_quota_settlement_status ON resource_quota_reservations(settlement_status)');
}

export function down(db: Db): void {
  db.exec('DROP INDEX IF EXISTS idx_resource_quota_settlement_status');
  db.exec('ALTER TABLE resource_quota_reservations DROP COLUMN settlement_status');
}
