import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_member_api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL REFERENCES resource_subpool_members(id) ON DELETE CASCADE,
      consumer_api_key_id INTEGER NOT NULL UNIQUE REFERENCES consumer_api_keys(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(member_id, consumer_api_key_id)
    );

    INSERT OR IGNORE INTO resource_member_api_keys (member_id, consumer_api_key_id)
    SELECT id, consumer_api_key_id
    FROM resource_subpool_members
    WHERE consumer_api_key_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_resource_member_api_keys_member
      ON resource_member_api_keys(member_id);

    CREATE TRIGGER IF NOT EXISTS trg_resource_member_primary_key_insert
    AFTER INSERT ON resource_subpool_members
    WHEN NEW.consumer_api_key_id IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO resource_member_api_keys (member_id, consumer_api_key_id)
      VALUES (NEW.id, NEW.consumer_api_key_id);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_resource_member_primary_key_update
    AFTER UPDATE OF consumer_api_key_id ON resource_subpool_members
    WHEN NEW.consumer_api_key_id IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO resource_member_api_keys (member_id, consumer_api_key_id)
      VALUES (NEW.id, NEW.consumer_api_key_id);
    END;
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_resource_member_primary_key_update;
    DROP TRIGGER IF EXISTS trg_resource_member_primary_key_insert;
    DROP TABLE IF EXISTS resource_member_api_keys;
  `);
}
