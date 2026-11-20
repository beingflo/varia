import { describe, expect, it } from 'vitest';
import { nodeDb } from './nodeSqlite';
import * as repo from './repo';
import { migrate } from './schema';
import type { Db } from './types';

/** A database from before ops had ids of their own, at the version that build left behind. */
function legacyDb(): Db {
  const db = nodeDb();
  migrate(db); // the current shape and version, then rewound to the old one
  db.exec(`
    DROP TABLE op;
    DROP TABLE todo_item_op;
    DROP TABLE op_seen;
    CREATE TABLE op(
      device TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, note_id TEXT NOT NULL,
      payload TEXT NOT NULL, lamport INTEGER NOT NULL, created INTEGER NOT NULL,
      pushed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (device, seq)
    );
    CREATE INDEX op_note ON op(note_id, lamport, device);
    CREATE TABLE todo_item_op(
      device TEXT NOT NULL, seq INTEGER NOT NULL, item_id TEXT NOT NULL, note_id TEXT NOT NULL,
      fields TEXT NOT NULL, lamport INTEGER NOT NULL, created INTEGER NOT NULL,
      PRIMARY KEY (device, seq)
    );
    CREATE TABLE op_seen(device TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (device, seq));
    INSERT INTO op(device, seq, kind, note_id, payload, lamport, created, pushed)
      VALUES ('dev-a', 1, 'note_meta', 'note-1', '{}', 1, 1700000000000, 0),
             ('dev-a', 2, 'note_snapshot', 'note-1', '{"body":"kept"}', 2, 1700000000001, 1);
    INSERT INTO todo_item_op(device, seq, item_id, note_id, fields, lamport, created)
      VALUES ('dev-a', 1, 'item-1', 'note-1', '{"text":"x"}', 1, 1700000000000);
    INSERT INTO op_seen(device, seq) VALUES ('dev-b', 9);
    PRAGMA user_version = 4;
  `);
  return db;
}

describe('client migrations', () => {
  it('brings an op log that predates op ids forward, keeping what it held', () => {
    const db = legacyDb();

    migrate(db);

    const columns = db.all<{ name: string }>('PRAGMA table_info(op)').map((field) => field.name);
    expect(columns).toContain('id');
    expect(columns).not.toContain('seq');
    expect(db.all<{ id: string; pushed: number }>('SELECT id, pushed FROM op ORDER BY lamport')).toEqual([
      { id: 'dev-a-1', pushed: 0 },
      { id: 'dev-a-2', pushed: 1 },
    ]);
    expect(db.all<{ id: string }>('SELECT id FROM todo_item_op')).toEqual([{ id: 'dev-a-1' }]);
    expect(db.all<{ id: string }>('SELECT id FROM op_seen')).toEqual([{ id: 'dev-b-9' }]);
    // Pushed stays pushed: the migration must not turn a delivered op back into an outbox entry.
    expect(repo.unpushed(db).map((op) => op.id)).toEqual(['dev-a-1']);
  });

  it('leaves a database written by this build alone, and writes work afterwards', () => {
    const db = legacyDb();
    migrate(db);
    migrate(db); // a second open is a no-op: the version guard, not the column check, decides

    const id = repo.createNote(db, 'note');
    repo.saveBody(db, id, 'typed after the migration');
    expect(repo.listNotes(db).map((note) => note.body)).toEqual(['typed after the migration']);
    // The ops this session wrote are the ones that used to fail with "no column named id".
    const written = repo.unpushed(db).filter((op) => op.note_id === id);
    expect(written.map((op) => op.kind)).toEqual(['note_meta', 'note_snapshot']);
    expect(written.every((op) => /^[0-9a-f-]{36}$/.test(op.id))).toBe(true);
  });
});
