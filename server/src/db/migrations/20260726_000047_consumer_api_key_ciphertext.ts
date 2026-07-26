import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(consumer_api_keys)').all() as Array<{ name: string }>;
  const addColumn = (name: string) => {
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE consumer_api_keys ADD COLUMN ${name} TEXT`);
    }
  };

  addColumn('key_encrypted');
  addColumn('key_iv');
  addColumn('key_auth_tag');
}

export function down(_db: Db): void {
  throw new Error('irreversible migration: SQLite requires a table rebuild to remove consumer API key ciphertext columns');
}
