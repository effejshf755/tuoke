import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS playground_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      user_id INTEGER NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

      title TEXT NOT NULL DEFAULT '新对话',

      model_id TEXT NOT NULL,

      system_prompt TEXT,

      created_at TEXT NOT NULL
        DEFAULT (datetime('now')),

      updated_at TEXT NOT NULL
        DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS playground_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      conversation_id INTEGER NOT NULL
        REFERENCES playground_conversations(id)
        ON DELETE CASCADE,

      role TEXT NOT NULL
        CHECK(role IN ('user', 'assistant')),

      content TEXT NOT NULL,

      prompt_tokens INTEGER,

      completion_tokens INTEGER,

      total_tokens INTEGER,

      cost_micro INTEGER,

      created_at TEXT NOT NULL
        DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS
      idx_playground_conversations_user_updated
      ON playground_conversations(
        user_id,
        updated_at
      );

    CREATE INDEX IF NOT EXISTS
      idx_playground_messages_conversation
      ON playground_messages(
        conversation_id,
        id
      );
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS playground_messages;
    DROP TABLE IF EXISTS playground_conversations;
  `);
}