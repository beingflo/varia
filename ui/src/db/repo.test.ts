import { describe, expect, it } from 'vitest';
import { nodeDb } from './nodeSqlite';
import * as repo from './repo';
import type { Db, Op } from './types';

function fresh(device = 'dev-a') {
  const db = nodeDb();
  repo.openDb(db, device);
  return db;
}

function remote(db: Db, op: Omit<Op, 'payload'> & { payload: Record<string, unknown> }): boolean {
  return repo.applyRemoteOp(db, op as Op);
}

function snapshot(db: Db, noteId: string, body: string, lamport: number, opts: { device?: string; parent?: string | null } = {}) {
  const device = opts.device ?? 'dev-b';
  return remote(db, {
    device,
    id: `op-${lamport}`,
    kind: 'note_snapshot',
    note_id: noteId,
    lamport,
    created: 1_700_000_000_000 + lamport,
    payload: { version_id: `${device}-${lamport}`, parent_version_id: opts.parent ?? null, body },
  });
}

function itemOp(db: Db, noteId: string, itemId: string, fields: Record<string, unknown>, lamport: number, device = 'dev-b') {
  return remote(db, {
    device,
    id: `op-${lamport}`,
    kind: 'todo_item',
    note_id: noteId,
    lamport,
    created: 1_700_000_000_000 + lamport,
    payload: { item_id: itemId, note_id: noteId, fields },
  });
}

describe('database setup', () => {
  it('keeps the device id across opens and initialises no notes', () => {
    const db = nodeDb();
    expect(repo.openDb(db)).toBe(repo.openDb(db));
    expect(repo.listNotes(db)).toEqual([]);
  });
});

describe('notes', () => {
  it('creates a note with a title derived from the first body line', () => {
    const db = fresh();
    const id = repo.createNote(db, 'note');
    repo.saveBody(db, id, '\n# Groceries\nmilk');
    const note = repo.getNote(db, id)!;
    expect(note.title).toBe('Groceries');
    expect(repo.listNotes(db).map((n) => n.id)).toEqual([id]);
  });

  it('writes no snapshot when the body did not change', () => {
    const db = fresh();
    const id = repo.createNote(db, 'note');
    expect(repo.saveBody(db, id, 'a')).toBe(true);
    expect(repo.saveBody(db, id, 'a')).toBe(false);
    expect(repo.versions(db, id)).toHaveLength(1);
  });

  it('chains snapshots by parent', () => {
    const db = fresh();
    const id = repo.createNote(db, 'note');
    repo.saveBody(db, id, 'one');
    repo.saveBody(db, id, 'two');
    const [newest, oldest] = repo.versions(db, id);
    expect(newest.parent_id).toBe(oldest.id);
    expect(repo.heads(db, id)).toEqual([newest]);
  });

  it('restores an old version as a new head', () => {
    const db = fresh();
    const id = repo.createNote(db, 'note');
    repo.saveBody(db, id, 'one');
    const first = repo.versions(db, id)[0];
    repo.saveBody(db, id, 'two');
    repo.restoreVersion(db, id, first.id);

    expect(repo.getNote(db, id)!.body).toBe('one');
    expect(repo.versions(db, id)).toHaveLength(3);
    expect(repo.heads(db, id)).toHaveLength(1);
  });

  it('keeps a competing branch from another device instead of overwriting it', () => {
    const db = fresh();
    const id = repo.createNote(db, 'note');
    repo.saveBody(db, id, 'mine');
    snapshot(db, id, 'theirs', 50);

    expect(repo.heads(db, id)).toHaveLength(2);
    expect(repo.getNote(db, id)!.body).toBe('theirs');
    expect(repo.versions(db, id).map((v) => v.body)).toEqual(['theirs', 'mine']);
  });

  it('ignores a snapshot that loses the lamport race', () => {
    const db = fresh();
    const id = repo.createNote(db, 'note');
    repo.saveBody(db, id, 'newer');

    snapshot(db, id, 'older but arrives late', 0, { parent: repo.versions(db, id)[0].id });

    expect(repo.getNote(db, id)!.body).toBe('newer');
    expect(repo.versions(db, id)).toHaveLength(2);
  });

  it('tombstones a deleted note', () => {
    const db = fresh();
    const id = repo.createNote(db, 'note');
    repo.setNoteMeta(db, id, { deleted: true });
    expect(repo.listNotes(db)).toEqual([]);
    expect(repo.getNote(db, id)!.deleted).toBe(1);
  });

  it('tags notes and filters by tag', () => {
    const db = fresh();
    const a = repo.createNote(db, 'note');
    const b = repo.createNote(db, 'note');
    repo.setNoteMeta(db, a, { tags: ['work', 'lab'] });
    repo.setNoteMeta(db, b, { tags: ['home'] });

    expect(repo.tags(db)).toEqual(['home', 'lab', 'work']);
    expect(repo.tagsOf(db, a)).toEqual(['lab', 'work']);
    expect(repo.listNotes(db, { tag: 'work' }).map((n) => n.id)).toEqual([a]);
  });

  it('refuses to save a body for a todo list', () => {
    const db = fresh();
    const id = repo.createNote(db, 'todo');
    expect(() => repo.saveBody(db, id, 'x')).toThrow(/is a todo/);
  });
});

describe('todo items', () => {
  it('adds items in order and hides done ones by default', () => {
    const db = fresh();
    const list = repo.createNote(db, 'todo', 'work');
    const a = repo.addItem(db, list, 'first');
    repo.addItem(db, list, 'second');
    repo.toggleItem(db, a);

    expect(repo.items(db, list).map((i) => i.text)).toEqual(['second']);
    expect(repo.items(db, list, true).map((i) => i.text)).toEqual(['first', 'second']);
    expect(repo.listNotes(db)[0].open_items).toBe(1);
  });

  it('edits and deletes items', () => {
    const db = fresh();
    const list = repo.createNote(db, 'todo');
    const id = repo.addItem(db, list, 'typo');
    repo.setItemText(db, id, 'fixed');
    expect(repo.items(db, list)[0].text).toBe('fixed');

    repo.removeItem(db, id);
    expect(repo.items(db, list, true)).toEqual([]);
  });

  it('applies last-writer-wins per field, not per item', () => {
    const db = fresh();
    const list = repo.createNote(db, 'todo');
    const id = repo.addItem(db, list, 'milk'); // lamport 2

    itemOp(db, list, id, { done: true }, 7, 'dev-b');
    itemOp(db, list, id, { text: 'oat milk' }, 5, 'dev-b');
    itemOp(db, list, id, { done: false }, 3, 'dev-b'); // older than the done it lost to

    const item = repo.items(db, list, true)[0];
    expect(item.text).toBe('oat milk');
    expect(item.done).toBe(1);
  });

  it('breaks lamport ties by device id and stays idempotent', () => {
    const db = fresh();
    const list = repo.createNote(db, 'todo');
    const id = repo.addItem(db, list, 'x');

    itemOp(db, list, id, { text: 'from b' }, 4, 'dev-b');
    itemOp(db, list, id, { text: 'from a' }, 4, 'dev-a'); // same lamport, lower device id: loses
    expect(repo.items(db, list)[0].text).toBe('from b');

    // The same op twice is a no-op, not a duplicate row in the log.
    expect(itemOp(db, list, id, { text: 'from b' }, 4, 'dev-b')).toBe(false);
  });

  it('moves the list timestamp with its items', async () => {
    const db = fresh();
    const list = repo.createNote(db, 'todo', 'work');
    const created = repo.getNote(db, list)!.updated;

    await new Promise((r) => setTimeout(r, 20));
    const item = repo.addItem(db, list, 'x');
    const afterAdd = repo.getNote(db, list)!.updated;
    expect(afterAdd).toBeGreaterThan(created);

    await new Promise((r) => setTimeout(r, 20));
    repo.toggleItem(db, item);
    expect(repo.getNote(db, list)!.updated).toBeGreaterThan(afterAdd);
  });

  it('keeps a change history per item', () => {
    const db = fresh();
    const list = repo.createNote(db, 'todo');
    const id = repo.addItem(db, list, 'x');
    repo.toggleItem(db, id);
    repo.setItemText(db, id, 'y');

    const history = repo.itemHistory(db, id);
    expect(history).toHaveLength(3);
    expect(JSON.parse(history[0].fields)).toEqual({ text: 'y' });
  });
});

describe('search', () => {
  it('matches note bodies, item texts and escaped wildcards', () => {
    const db = fresh();
    const note = repo.createNote(db, 'note');
    repo.saveBody(db, note, 'about the coalesce operator');
    const list = repo.createNote(db, 'todo');
    repo.addItem(db, list, 'buy 100% cacao');

    expect(repo.listNotes(db, { q: 'coalesce' }).map((n) => n.id)).toEqual([note]);
    expect(repo.listNotes(db, { q: 'cacao' }).map((n) => n.id)).toEqual([list]);
    expect(repo.listNotes(db, { q: '100%' }).map((n) => n.id)).toEqual([list]);
    expect(repo.listNotes(db, { q: '10%' })).toEqual([]);
  });
});

describe('op log', () => {
  it('grows monotonically and queues unpushed ops', () => {
    const db = fresh();
    const id = repo.createNote(db, 'note');
    repo.saveBody(db, id, 'a');
    repo.setNoteMeta(db, id, { tags: ['x'] });

    const ops = repo.unpushed(db);
    expect(ops.map((o) => o.kind)).toEqual(['note_meta', 'note_snapshot', 'note_meta']);
    expect(ops.map((o) => o.lamport)).toEqual([1, 2, 3]);
    expect(ops).toHaveLength(3);

    repo.markPushed(db, ops);
    expect(repo.unpushed(db)).toEqual([]);
  });

  it('replays a foreign log into a fresh database', () => {
    const source = fresh('dev-a');
    const list = repo.createNote(source, 'todo', 'shared');
    repo.addItem(source, list, 'one');
    repo.addItem(source, list, 'two');

    const target = fresh('dev-b');
    for (const op of repo.unpushed(source)) repo.applyRemoteOp(target, op);

    expect(repo.listNotes(target).map((n) => n.title)).toEqual(['shared']);
    expect(repo.items(target, list, true).map((i) => i.text)).toEqual(['one', 'two']);
  });
});

describe('debug reads', () => {
  it('lists every table with a count', () => {
    const db = fresh();
    const id = repo.createNote(db, 'note');
    repo.saveBody(db, id, 'body');

    const tables = repo.debugTables(db);
    expect(tables.map((t) => t.name)).toContain('op');
    expect(tables.find((t) => t.name === 'version')?.count).toBe(1);
    expect(tables.find((t) => t.name === 'note')?.count).toBe(1);
  });

  it('pages rows and reports columns', () => {
    const db = fresh();
    const id = repo.createNote(db, 'note');
    repo.saveBody(db, id, 'one');
    repo.saveBody(db, id, 'two');
    repo.saveBody(db, id, 'three');

    const first = repo.debugRows(db, 'version', 0, 2);
    expect(first.total).toBe(3);
    expect(first.rows).toHaveLength(2);
    expect(first.columns).toContain('parent_id');
    expect(first.rows[0].body).toBe('three'); // newest first

    const second = repo.debugRows(db, 'version', 2, 2);
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].body).toBe('one');
  });

  // The counter this replaced was guessable: a token holder could squat a device's next sequence
  // number and the server's dedupe would swallow the real op. A cloned database collided too.
  it('identifies ops by a random id, so twins with the same device id cannot collide', () => {
    const twinA = fresh('same-device');
    const twinB = fresh('same-device'); // a restored backup of the same profile
    const noteA = repo.createNote(twinA, 'note');
    const noteB = repo.createNote(twinB, 'note');

    const [opA] = repo.unpushed(twinA);
    const [opB] = repo.unpushed(twinB);
    expect(opA.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(opA.id).not.toBe(opB.id);

    // A third database applies both: neither is mistaken for the other.
    const target = fresh('device-c');
    expect(repo.applyRemoteOps(target, [opA, opB])).toBe(2);
    expect(repo.listNotes(target).map((note) => note.id).sort()).toEqual([noteA, noteB].sort());
    // ...and re-applying either is still a no-op.
    expect(repo.applyRemoteOps(target, [opA, opB])).toBe(0);
  });

  it('records the pull cursor with the account it belongs to, in one call with the ops', () => {
    const db = fresh();
    const op: Op = {
      id: 'op-r1',
      device: 'dev-b',
      kind: 'note_meta',
      note_id: 'n1',
      lamport: 1,
      created: 1_700_000_000_000,
      payload: { note_id: 'n1', kind: 'note', title: 'T', deleted: false, tags: [] },
    } as Op;

    expect(repo.applyRemotePage(db, [op], 7, 'acct-a')).toBe(1);
    expect(repo.syncCursor(db, 'acct-a')).toBe(7);
    // A different account's cursor is not this account's: the value is useless, so it reads as 0.
    expect(repo.syncCursor(db, 'acct-b')).toBe(0);
    // The cursor never moves backwards within an account.
    expect(repo.applyRemotePage(db, [], 3, 'acct-a')).toBe(0);
    expect(repo.syncCursor(db, 'acct-a')).toBe(7);
  });

  it('shows the op log newest first', () => {
    const db = fresh();
    const id = repo.createNote(db, 'note');
    repo.saveBody(db, id, 'x');

    const ops = repo.debugRows(db, 'op', 0, 10).rows;
    expect(ops).toHaveLength(2);
    expect(ops[0].kind).toBe('note_snapshot');
  });

  it('refuses tables it does not know', () => {
    const db = fresh();
    expect(() => repo.debugRows(db, 'sqlite_master')).toThrow(/unknown table/);
  });
});
