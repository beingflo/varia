import type { Db } from './types';

// The client owns the schema: the server keeps only an encrypted log (design/002).
// shortcut: LIKE search over note bodies and item texts, switch to FTS5 when notes reach a few MB.
const migration1 = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE note(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'todo')),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  stamps TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE version(
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES note(id),
  parent_id TEXT,
  body TEXT NOT NULL,
  lamport INTEGER NOT NULL,
  device TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX version_note ON version(note_id, lamport DESC, device DESC);
CREATE INDEX version_parent ON version(parent_id);

CREATE TABLE todo_item(
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES note(id),
  text TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  ordering REAL NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL,
  stamps TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX todo_item_note ON todo_item(note_id, deleted, ordering);

CREATE TABLE todo_item_op(
  id TEXT PRIMARY KEY,
  device TEXT NOT NULL,
  item_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  fields TEXT NOT NULL,
  lamport INTEGER NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX todo_item_op_item ON todo_item_op(item_id, lamport DESC);

CREATE TABLE tag(name TEXT PRIMARY KEY);
CREATE TABLE note_tag(
  note_id TEXT NOT NULL REFERENCES note(id),
  name TEXT NOT NULL,
  PRIMARY KEY (note_id, name)
);

-- Append-only log: the source of truth, and the push outbox.
CREATE TABLE op(
  id TEXT PRIMARY KEY,
  device TEXT NOT NULL,
  kind TEXT NOT NULL,
  note_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  lamport INTEGER NOT NULL,
  created INTEGER NOT NULL,
  pushed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX op_note ON op(note_id, lamport, device);
CREATE INDEX op_unpushed ON op(pushed, created);

-- Pulled ops already applied.
CREATE TABLE op_seen(id TEXT PRIMARY KEY);

CREATE TABLE sync_state(
  device TEXT PRIMARY KEY,
  server_cursor INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER
);
`;

// Nesting: items are a flat, ordered table with a depth, so children are the following rows with
// a greater depth. No FK, no tree table, and the sync payload stays one row per change.
const migration2 = `ALTER TABLE todo_item ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;`;

const migrations: string[] = [migration1, migration2];

export function migrate(db: Db): void {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  const applied = row?.user_version ?? 0;
  for (let i = applied; i < migrations.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
