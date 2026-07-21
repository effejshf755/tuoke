import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user'))");
  }
  db.prepare("UPDATE users SET role = 'admin'").run();
}

export function down(db: Db): void {
  db.exec(`
    CREATE TABLE users_role_backup (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO users_role_backup SELECT id, email, password_hash, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_role_backup RENAME TO users;
  `);
}
