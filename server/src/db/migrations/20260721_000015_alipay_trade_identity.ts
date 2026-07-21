import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recharge_orders_provider_trade_no
    ON recharge_orders(payment_provider, provider_trade_no)
    WHERE payment_provider IS NOT NULL AND provider_trade_no IS NOT NULL;
  `);
}

export function down(db: Db): void {
  db.exec('DROP INDEX IF EXISTS idx_recharge_orders_provider_trade_no;');
}
