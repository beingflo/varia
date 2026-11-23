import type { Db } from './types';

// The client owns the schema: the server keeps only an encrypted log (design/002).
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

// Heads a user has already looked at or decided about: divergence bookkeeping, not history.
const migration3 = `ALTER TABLE note ADD COLUMN acknowledged TEXT NOT NULL DEFAULT '[]';`;

// Divergence has no UI state: the tree shows it, the user resolves it by editing. Drop the column
// that used to hold the acknowledged head ids.
const migration4 = `ALTER TABLE note DROP COLUMN acknowledged;`;

/**
 * A database written before ops had ids of their own: `op` and `todo_item_op` were keyed by
 * (device, seq) and `op_seen` followed the wire, which carried the same pair. `migration1` was
 * edited in place back then, and `CREATE TABLE IF NOT EXISTS` leaves such a database in the old
 * shape for ever — every write then fails with "table op has no column named id". Rebuild the
 * three tables; the derived ids are local, and nothing already pushed is pushed again.
 */
function migration5(db: Db): void {
  const has = (table: string, column: string) =>
    db.all<{ name: string }>(`PRAGMA table_info(${table})`).some((field) => field.name === column);
  if (has('op', 'id')) return;
  db.exec(`
    CREATE TABLE op_new(
      id TEXT PRIMARY KEY,
      device TEXT NOT NULL,
      kind TEXT NOT NULL,
      note_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      lamport INTEGER NOT NULL,
      created INTEGER NOT NULL,
      pushed INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO op_new(id, device, kind, note_id, payload, lamport, created, pushed)
      SELECT device || '-' || seq, device, kind, note_id, payload, lamport, created, pushed FROM op;
    DROP TABLE op;
    ALTER TABLE op_new RENAME TO op;
    CREATE INDEX op_note ON op(note_id, lamport, device);
    CREATE INDEX op_unpushed ON op(pushed, created);

    CREATE TABLE todo_item_op_new(
      id TEXT PRIMARY KEY,
      device TEXT NOT NULL,
      item_id TEXT NOT NULL,
      note_id TEXT NOT NULL,
      fields TEXT NOT NULL,
      lamport INTEGER NOT NULL,
      created INTEGER NOT NULL
    );
    INSERT INTO todo_item_op_new(id, device, item_id, note_id, fields, lamport, created)
      SELECT device || '-' || seq, device, item_id, note_id, fields, lamport, created FROM todo_item_op;
    DROP TABLE todo_item_op;
    ALTER TABLE todo_item_op_new RENAME TO todo_item_op;
    CREATE INDEX todo_item_op_item ON todo_item_op(item_id, lamport DESC);

    CREATE TABLE op_seen_new(id TEXT PRIMARY KEY);
    INSERT INTO op_seen_new(id) SELECT device || '-' || seq FROM op_seen;
    DROP TABLE op_seen;
    ALTER TABLE op_seen_new RENAME TO op_seen;
  `);
}

/**
 * One searchable document per note: title, body and its live item texts in a single row, so a term
 * in the body and a term in an item still match the same note. Contentless because the text already
 * lives in `note`/`todo_item`, and `detail=none` because the query only ever ANDs prefixed terms —
 * never phrases — which keeps the index a tenth of the size instead of doubling it.
 */
const doc = (title: string, body: string, id: string) =>
  `${title} || char(10) || ${body} || char(10) || coalesce((SELECT group_concat(text, char(10))
     FROM todo_item WHERE note_id = ${id} AND deleted = 0), '')`;

// Keys on `note.rowid`, which nothing rewrites (a VACUUM would; the index is derived, so the fix
// is a rebuild). An item's hard delete only happens in `purge`, where the note goes with it.
// shortcut: the backfill is one transaction at boot, seconds at a few MB and minutes near 500 MB —
// chunk it with progress when notes get that big.
const migration6 = `
CREATE VIRTUAL TABLE note_fts USING fts5(doc, content='', detail=none, contentless_delete=1,
  tokenize='unicode61');
CREATE TRIGGER note_fts_ai AFTER INSERT ON note BEGIN
  INSERT INTO note_fts(rowid, doc) VALUES (new.rowid, ${doc('new.title', 'new.body', 'new.id')});
END;
CREATE TRIGGER note_fts_ad AFTER DELETE ON note BEGIN
  DELETE FROM note_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER note_fts_au AFTER UPDATE OF title, body ON note BEGIN
  DELETE FROM note_fts WHERE rowid = old.rowid;
  INSERT INTO note_fts(rowid, doc) VALUES (new.rowid, ${doc('new.title', 'new.body', 'new.id')});
END;
CREATE TRIGGER item_fts_ai AFTER INSERT ON todo_item BEGIN
  DELETE FROM note_fts WHERE rowid = (SELECT rowid FROM note WHERE id = new.note_id);
  INSERT INTO note_fts(rowid, doc) SELECT n.rowid, ${doc('n.title', 'n.body', 'n.id')}
    FROM note n WHERE n.id = new.note_id;
END;
CREATE TRIGGER item_fts_au AFTER UPDATE OF text, deleted ON todo_item BEGIN
  DELETE FROM note_fts WHERE rowid = (SELECT rowid FROM note WHERE id = new.note_id);
  INSERT INTO note_fts(rowid, doc) SELECT n.rowid, ${doc('n.title', 'n.body', 'n.id')}
    FROM note n WHERE n.id = new.note_id;
END;

INSERT INTO note_fts(rowid, doc) SELECT rowid, ${doc('title', 'body', 'id')} FROM note;
`;

const migrations: (string | ((db: Db) => void))[] = [
  migration1, migration2, migration3, migration4, migration5, searchIndex,
];

/** Like `migration5`: a database whose version was rewound keeps the index it already has. */
function searchIndex(db: Db): void {
  if (db.get("SELECT 1 FROM sqlite_master WHERE name = 'note_fts'")) return;
  db.exec(migration6);
}

export function migrate(db: Db): void {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  const applied = row?.user_version ?? 0;
  for (let i = applied; i < migrations.length; i++) {
    const step = migrations[i];
    db.exec('BEGIN');
    try {
      if (typeof step === 'string') db.exec(step);
      else step(db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
