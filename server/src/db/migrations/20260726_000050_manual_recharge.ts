import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(recharge_orders)').all() as { name: string }[];
  const addColumn = (name: string, definition: string) => {
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE recharge_orders ADD COLUMN ${name} ${definition}`);
    }
  };

  addColumn('payment_reference', 'TEXT');
  addColumn('payment_proof', 'BLOB');
  addColumn('payment_proof_mime', 'TEXT');
  addColumn('proof_submitted_at', 'TEXT');

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recharge_orders_payment_reference
      ON recharge_orders(payment_reference)
      WHERE payment_reference IS NOT NULL;
  `);
}

export function down(db: Db): void {
  db.exec('DROP INDEX IF EXISTS idx_recharge_orders_payment_reference;');
}
