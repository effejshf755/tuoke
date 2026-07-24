import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    ALTER TABLE resource_subpools ADD COLUMN frozen_total_quota_units INTEGER
      CHECK (frozen_total_quota_units IS NULL OR frozen_total_quota_units > 0);
    ALTER TABLE resource_subpools ADD COLUMN frozen_member_quota_units INTEGER
      CHECK (frozen_member_quota_units IS NULL OR frozen_member_quota_units > 0);
    ALTER TABLE resource_subpools ADD COLUMN frozen_meter_version TEXT;
    ALTER TABLE resource_subpools ADD COLUMN frozen_at TEXT;

    UPDATE resource_subpools
    SET frozen_total_quota_units = (
          SELECT o.total_quota_units_snapshot FROM resource_subpool_members m
          JOIN resource_orders o ON o.id = m.resource_order_id
          WHERE m.subpool_id = resource_subpools.id ORDER BY m.id LIMIT 1
        ),
        frozen_member_quota_units = (
          SELECT o.member_quota_units_snapshot FROM resource_subpool_members m
          JOIN resource_orders o ON o.id = m.resource_order_id
          WHERE m.subpool_id = resource_subpools.id ORDER BY m.id LIMIT 1
        ),
        frozen_meter_version = (
          SELECT o.meter_version_snapshot FROM resource_subpool_members m
          JOIN resource_orders o ON o.id = m.resource_order_id
          WHERE m.subpool_id = resource_subpools.id ORDER BY m.id LIMIT 1
        ),
        frozen_at = COALESCE(activated_at, updated_at, datetime('now'))
    WHERE status IN ('waiting_resource', 'active', 'paused', 'expired')
      AND EXISTS (
        SELECT 1 FROM resource_subpool_members m
        JOIN resource_orders o ON o.id = m.resource_order_id
        WHERE m.subpool_id = resource_subpools.id
      )
      AND (SELECT MIN(o.total_quota_units_snapshot) FROM resource_subpool_members m
           JOIN resource_orders o ON o.id = m.resource_order_id
           WHERE m.subpool_id = resource_subpools.id)
        = (SELECT MAX(o.total_quota_units_snapshot) FROM resource_subpool_members m
           JOIN resource_orders o ON o.id = m.resource_order_id
           WHERE m.subpool_id = resource_subpools.id)
      AND (SELECT MIN(o.member_quota_units_snapshot) FROM resource_subpool_members m
           JOIN resource_orders o ON o.id = m.resource_order_id
           WHERE m.subpool_id = resource_subpools.id)
        = (SELECT MAX(o.member_quota_units_snapshot) FROM resource_subpool_members m
           JOIN resource_orders o ON o.id = m.resource_order_id
           WHERE m.subpool_id = resource_subpools.id)
      AND (SELECT MIN(o.meter_version_snapshot) FROM resource_subpool_members m
           JOIN resource_orders o ON o.id = m.resource_order_id
           WHERE m.subpool_id = resource_subpools.id)
        = (SELECT MAX(o.meter_version_snapshot) FROM resource_subpool_members m
           JOIN resource_orders o ON o.id = m.resource_order_id
           WHERE m.subpool_id = resource_subpools.id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    ALTER TABLE resource_subpools DROP COLUMN frozen_at;
    ALTER TABLE resource_subpools DROP COLUMN frozen_meter_version;
    ALTER TABLE resource_subpools DROP COLUMN frozen_member_quota_units;
    ALTER TABLE resource_subpools DROP COLUMN frozen_total_quota_units;
  `);
}
