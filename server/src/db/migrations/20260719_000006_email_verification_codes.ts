import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'register'
        CHECK (purpose IN ('register')),
      expires_at TEXT NOT NULL,
      used_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_email_verification_codes_email_purpose
      ON email_verification_codes (email, purpose, created_at);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS email_verification_codes;
  `);
}