import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    ALTER TABLE resource_subpools RENAME COLUMN status TO legacy_status;
    ALTER TABLE resource_subpools ADD COLUMN status TEXT NOT NULL DEFAULT 'waiting_members'
      CHECK (status IN ('waiting_members', 'waiting_resource', 'active', 'paused', 'expired'));
    UPDATE resource_subpools
    SET status = CASE legacy_status
      WHEN 'active' THEN 'active'
      WHEN 'paused' THEN 'paused'
      WHEN 'expired' THEN 'expired'
      ELSE 'waiting_members'
    END;

    CREATE TRIGGER IF NOT EXISTS trg_resource_subpool_member_limit
    BEFORE INSERT ON resource_subpool_members
    FOR EACH ROW
    WHEN (
      SELECT COUNT(*) FROM resource_subpool_members WHERE subpool_id = NEW.subpool_id
    ) >= (
      SELECT member_limit FROM resource_subpools WHERE id = NEW.subpool_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'resource_subpool_member_limit_exceeded');
    END;

    CREATE INDEX IF NOT EXISTS idx_resource_subpools_product_status
      ON resource_subpools(product_id, status, id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_resource_subpools_product_status;
    DROP TRIGGER IF EXISTS trg_resource_subpool_member_limit;
    UPDATE resource_subpools
    SET legacy_status = CASE status
      WHEN 'active' THEN 'active'
      WHEN 'paused' THEN 'paused'
      WHEN 'expired' THEN 'expired'
      ELSE 'draft'
    END;
    ALTER TABLE resource_subpools DROP COLUMN status;
    ALTER TABLE resource_subpools RENAME COLUMN legacy_status TO status;
  `);
}
