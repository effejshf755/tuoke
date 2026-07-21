import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recharge_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      order_no TEXT NOT NULL UNIQUE,

      user_id INTEGER NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

      amount_micro INTEGER NOT NULL
        CHECK (amount_micro > 0),

      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
          status IN (
            'pending',
            'paid',
            'cancelled',
            'expired'
          )
        ),

      payment_method TEXT,

      payment_provider TEXT,

      provider_trade_no TEXT,

      note TEXT,

      created_at TEXT NOT NULL
        DEFAULT (datetime('now')),

      updated_at TEXT NOT NULL
        DEFAULT (datetime('now')),

      expires_at TEXT,

      paid_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS
      idx_recharge_orders_order_no
      ON recharge_orders(order_no);

    CREATE INDEX IF NOT EXISTS
      idx_recharge_orders_user
      ON recharge_orders(user_id);

    CREATE INDEX IF NOT EXISTS
      idx_recharge_orders_status
      ON recharge_orders(status);

    CREATE INDEX IF NOT EXISTS
      idx_recharge_orders_created
      ON recharge_orders(created_at);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS
      idx_recharge_orders_created;

    DROP INDEX IF EXISTS
      idx_recharge_orders_status;

    DROP INDEX IF EXISTS
      idx_recharge_orders_user;

    DROP INDEX IF EXISTS
      idx_recharge_orders_order_no;

    DROP TABLE IF EXISTS
      recharge_orders;
  `);
}
