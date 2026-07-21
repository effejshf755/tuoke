import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'monthly_token_limit')) db.exec("ALTER TABLE users ADD COLUMN monthly_token_limit INTEGER NOT NULL DEFAULT 1000000");
}

export function down(db: Db): void {
  db.pragma('foreign_keys = OFF');
  db.exec(`CREATE TABLE users_monthly_limit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')));
    INSERT INTO users (id, email, password_hash, created_at, role)
      SELECT id, email, password_hash, created_at, role FROM users_monthly_limit;
    DROP TABLE users;
    ALTER TABLE users_monthly_limit RENAME TO users;
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`);
  db.pragma('foreign_keys = ON');
}
