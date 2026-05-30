const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'inbox.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id           TEXT PRIMARY KEY,
    contact_name TEXT NOT NULL,
    channel      TEXT NOT NULL DEFAULT 'unknown',
    last_message TEXT,
    last_time    INTEGER NOT NULL,
    unread       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    text            TEXT NOT NULL,
    direction       TEXT NOT NULL CHECK(direction IN ('in', 'out')),
    timestamp       INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, timestamp);
`);

module.exports = db;
