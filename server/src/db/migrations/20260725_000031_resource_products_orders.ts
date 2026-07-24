import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      name TEXT NOT NULL,
      description TEXT,
      resource_type TEXT NOT NULL DEFAULT 'codex' CHECK (resource_type = 'codex'),
      mode TEXT NOT NULL DEFAULT 'dedicated' CHECK (mode = 'dedicated'),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'published', 'unpublished', 'archived')),
      price_micro INTEGER NOT NULL CHECK (price_micro > 0),
      member_limit INTEGER NOT NULL CHECK (member_limit >= 2),
      duration_value INTEGER NOT NULL CHECK (duration_value > 0),
      duration_unit TEXT NOT NULL CHECK (duration_unit IN ('day', 'month')),
      quota_allocation_type TEXT NOT NULL DEFAULT 'equal'
        CHECK (quota_allocation_type IN ('equal', 'fixed')),
      total_quota_units INTEGER NOT NULL CHECK (total_quota_units > 0),
      member_quota_units INTEGER NOT NULL CHECK (member_quota_units > 0),
      meter_version TEXT NOT NULL DEFAULT 'tokens-v1',
      group_timeout_minutes INTEGER NOT NULL CHECK (group_timeout_minutes > 0),
      refund_window_minutes INTEGER NOT NULL DEFAULT 60 CHECK (refund_window_minutes >= 0),
      sale_starts_at TEXT,
      sale_ends_at TEXT,
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (product_key, version),
      CHECK (member_quota_units * member_limit <= total_quota_units),
      CHECK (sale_starts_at IS NULL OR sale_ends_at IS NULL OR datetime(sale_starts_at) < datetime(sale_ends_at))
    );

    CREATE TABLE IF NOT EXISTS resource_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      product_id INTEGER NOT NULL REFERENCES resource_products(id) ON DELETE RESTRICT,
      subpool_id INTEGER REFERENCES resource_subpools(id) ON DELETE RESTRICT,
      product_key TEXT NOT NULL,
      product_version INTEGER NOT NULL CHECK (product_version > 0),
      product_name_snapshot TEXT NOT NULL,
      price_micro INTEGER NOT NULL CHECK (price_micro > 0),
      member_limit_snapshot INTEGER NOT NULL CHECK (member_limit_snapshot >= 2),
      duration_value_snapshot INTEGER NOT NULL CHECK (duration_value_snapshot > 0),
      duration_unit_snapshot TEXT NOT NULL CHECK (duration_unit_snapshot IN ('day', 'month')),
      quota_allocation_type_snapshot TEXT NOT NULL
        CHECK (quota_allocation_type_snapshot IN ('equal', 'fixed')),
      total_quota_units_snapshot INTEGER NOT NULL CHECK (total_quota_units_snapshot > 0),
      member_quota_units_snapshot INTEGER NOT NULL CHECK (member_quota_units_snapshot > 0),
      meter_version_snapshot TEXT NOT NULL,
      group_timeout_minutes_snapshot INTEGER NOT NULL CHECK (group_timeout_minutes_snapshot > 0),
      refund_window_minutes_snapshot INTEGER NOT NULL CHECK (refund_window_minutes_snapshot >= 0),
      order_status TEXT NOT NULL DEFAULT 'pending_payment'
        CHECK (order_status IN (
          'pending_payment', 'paid_waiting_group', 'grouped', 'active',
          'completed', 'cancelled', 'expired', 'refund_pending', 'refunded', 'failed'
        )),
      payment_method TEXT,
      payment_provider TEXT,
      provider_trade_no TEXT UNIQUE,
      paid_amount_micro INTEGER CHECK (paid_amount_micro IS NULL OR paid_amount_micro >= 0),
      paid_at TEXT,
      payment_expires_at TEXT,
      refundable_until TEXT,
      refund_amount_micro INTEGER CHECK (refund_amount_micro IS NULL OR refund_amount_micro >= 0),
      provider_refund_no TEXT,
      refund_reason TEXT,
      refund_requested_at TEXT,
      refunded_at TEXT,
      cancelled_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_resource_products_status
      ON resource_products(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_resource_products_key_version
      ON resource_products(product_key, version);
    CREATE INDEX IF NOT EXISTS idx_resource_orders_user
      ON resource_orders(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_resource_orders_status
      ON resource_orders(order_status, created_at);
    CREATE INDEX IF NOT EXISTS idx_resource_orders_product
      ON resource_orders(product_id, order_status);
    CREATE INDEX IF NOT EXISTS idx_resource_orders_subpool
      ON resource_orders(subpool_id);
  `);

  const subpoolColumns = db.prepare(`PRAGMA table_info(resource_subpools)`).all() as Array<{ name: string }>;
  if (!subpoolColumns.some((column) => column.name === 'product_id')) {
    db.exec(`ALTER TABLE resource_subpools ADD COLUMN product_id INTEGER REFERENCES resource_products(id) ON DELETE RESTRICT`);
  }
  const memberColumns = db.prepare(`PRAGMA table_info(resource_subpool_members)`).all() as Array<{ name: string }>;
  if (!memberColumns.some((column) => column.name === 'resource_order_id')) {
    db.exec(`ALTER TABLE resource_subpool_members ADD COLUMN resource_order_id INTEGER REFERENCES resource_orders(id) ON DELETE RESTRICT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_resource_subpools_product ON resource_subpools(product_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_member_order
      ON resource_subpool_members(resource_order_id) WHERE resource_order_id IS NOT NULL;
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_resource_member_order;
    DROP INDEX IF EXISTS idx_resource_subpools_product;
    ALTER TABLE resource_subpool_members DROP COLUMN resource_order_id;
    ALTER TABLE resource_subpools DROP COLUMN product_id;
    DROP INDEX IF EXISTS idx_resource_orders_subpool;
    DROP INDEX IF EXISTS idx_resource_orders_product;
    DROP INDEX IF EXISTS idx_resource_orders_status;
    DROP INDEX IF EXISTS idx_resource_orders_user;
    DROP TABLE IF EXISTS resource_orders;
    DROP INDEX IF EXISTS idx_resource_products_key_version;
    DROP INDEX IF EXISTS idx_resource_products_status;
    DROP TABLE IF EXISTS resource_products;
  `);
}
