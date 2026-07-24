import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_subpools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      resource_type TEXT NOT NULL DEFAULT 'codex',
      mode TEXT NOT NULL DEFAULT 'dedicated'
        CHECK (mode IN ('dedicated', 'scheduled')),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'paused', 'expired')),
      member_limit INTEGER NOT NULL CHECK (member_limit > 0),
      scheduler_pool_id INTEGER REFERENCES resource_scheduler_pools(id) ON DELETE RESTRICT,
      starts_at TEXT,
      ends_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS resource_subpool_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subpool_id INTEGER NOT NULL REFERENCES resource_subpools(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      consumer_api_key_id INTEGER UNIQUE REFERENCES consumer_api_keys(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('waiting', 'active', 'suspended', 'expired')),
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      activated_at TEXT,
      expires_at TEXT,
      UNIQUE (subpool_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS resource_subpool_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subpool_id INTEGER NOT NULL REFERENCES resource_subpools(id) ON DELETE CASCADE,
      codex_account_id INTEGER NOT NULL REFERENCES codex_oauth_accounts(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'migrating', 'released')),
      bound_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_subpool_active_binding
      ON resource_subpool_bindings(subpool_id)
      WHERE status IN ('active', 'migrating');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_account_active_binding
      ON resource_subpool_bindings(codex_account_id)
      WHERE status IN ('active', 'migrating');

    CREATE TABLE IF NOT EXISTS resource_subpool_quota_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subpool_id INTEGER NOT NULL REFERENCES resource_subpools(id) ON DELETE CASCADE,
      period_key TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'official_account'
        CHECK (source_type IN ('official_account', 'migrated_snapshot', 'product_reset', 'admin')),
      source_account_id INTEGER REFERENCES codex_oauth_accounts(id) ON DELETE SET NULL,
      allocation_units INTEGER NOT NULL CHECK (allocation_units >= 0),
      used_units INTEGER NOT NULL DEFAULT 0 CHECK (used_units >= 0),
      reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
      starts_at TEXT NOT NULL,
      resets_at TEXT,
      meter_version TEXT NOT NULL DEFAULT 'tokens-v1',
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'closed', 'expired')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      UNIQUE (subpool_id, period_key)
    );

    CREATE TABLE IF NOT EXISTS resource_member_quotas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subpool_period_id INTEGER NOT NULL REFERENCES resource_subpool_quota_periods(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES resource_subpool_members(id) ON DELETE CASCADE,
      allocation_units INTEGER NOT NULL CHECK (allocation_units >= 0),
      used_units INTEGER NOT NULL DEFAULT 0 CHECK (used_units >= 0),
      reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'closed')),
      UNIQUE (subpool_period_id, member_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_subpool_active_period
      ON resource_subpool_quota_periods(subpool_id)
      WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS resource_quota_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_correlation_id TEXT NOT NULL UNIQUE,
      subpool_id INTEGER NOT NULL REFERENCES resource_subpools(id) ON DELETE CASCADE,
      period_id INTEGER NOT NULL REFERENCES resource_subpool_quota_periods(id) ON DELETE CASCADE,
      member_quota_id INTEGER NOT NULL REFERENCES resource_member_quotas(id) ON DELETE CASCADE,
      reserved_units INTEGER NOT NULL CHECK (reserved_units > 0),
      actual_units INTEGER,
      request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'settled', 'released', 'failed')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      settled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS resource_quota_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subpool_id INTEGER NOT NULL REFERENCES resource_subpools(id) ON DELETE CASCADE,
      period_id INTEGER NOT NULL REFERENCES resource_subpool_quota_periods(id) ON DELETE CASCADE,
      member_id INTEGER REFERENCES resource_subpool_members(id) ON DELETE SET NULL,
      reservation_id INTEGER REFERENCES resource_quota_reservations(id) ON DELETE SET NULL,
      request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
      type TEXT NOT NULL CHECK (type IN ('reservation', 'settlement', 'release', 'reset', 'adjustment')),
      delta_units INTEGER NOT NULL,
      balance_after_units INTEGER NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS resource_scheduler_pools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      resource_type TEXT NOT NULL DEFAULT 'codex',
      status TEXT NOT NULL DEFAULT 'disabled'
        CHECK (status IN ('disabled', 'ready', 'maintenance')),
      strategy TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS resource_scheduler_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduler_pool_id INTEGER NOT NULL REFERENCES resource_scheduler_pools(id) ON DELETE CASCADE,
      codex_account_id INTEGER NOT NULL REFERENCES codex_oauth_accounts(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'disabled', 'maintenance', 'unhealthy')),
      priority INTEGER NOT NULL DEFAULT 0,
      weight INTEGER NOT NULL DEFAULT 100 CHECK (weight > 0),
      max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrency > 0),
      inflight_count INTEGER NOT NULL DEFAULT 0 CHECK (inflight_count >= 0),
      last_dispatched_at TEXT,
      UNIQUE (scheduler_pool_id, codex_account_id)
    );

    CREATE TABLE IF NOT EXISTS resource_subpool_scheduler_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subpool_id INTEGER NOT NULL REFERENCES resource_subpools(id) ON DELETE CASCADE,
      scheduler_pool_id INTEGER NOT NULL REFERENCES resource_scheduler_pools(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'suspended')),
      joined_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_subpool_scheduler_active
      ON resource_subpool_scheduler_memberships(subpool_id)
      WHERE status IN ('pending', 'active');

    CREATE TABLE IF NOT EXISTS resource_dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_correlation_id TEXT NOT NULL,
      subpool_id INTEGER NOT NULL REFERENCES resource_subpools(id) ON DELETE CASCADE,
      scheduler_pool_id INTEGER REFERENCES resource_scheduler_pools(id) ON DELETE SET NULL,
      codex_account_id INTEGER NOT NULL REFERENCES codex_oauth_accounts(id) ON DELETE RESTRICT,
      quota_reservation_id INTEGER NOT NULL REFERENCES resource_quota_reservations(id) ON DELETE RESTRICT,
      model_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'selected'
        CHECK (status IN ('selected', 'started', 'succeeded', 'failed')),
      decision_reason TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      UNIQUE (request_correlation_id, attempt_no)
    );

    CREATE INDEX IF NOT EXISTS idx_resource_members_user_status
      ON resource_subpool_members(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_resource_periods_subpool_status
      ON resource_subpool_quota_periods(subpool_id, status);
    CREATE INDEX IF NOT EXISTS idx_resource_reservations_status_expiry
      ON resource_quota_reservations(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_resource_dispatches_subpool_created
      ON resource_dispatches(subpool_id, created_at);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS resource_dispatches;
    DROP TABLE IF EXISTS resource_subpool_scheduler_memberships;
    DROP TABLE IF EXISTS resource_scheduler_assets;
    DROP TABLE IF EXISTS resource_scheduler_pools;
    DROP TABLE IF EXISTS resource_quota_ledger;
    DROP TABLE IF EXISTS resource_quota_reservations;
    DROP TABLE IF EXISTS resource_member_quotas;
    DROP TABLE IF EXISTS resource_subpool_quota_periods;
    DROP TABLE IF EXISTS resource_subpool_bindings;
    DROP TABLE IF EXISTS resource_subpool_members;
    DROP TABLE IF EXISTS resource_subpools;
  `);
}
