// Local-first data layer. Every write appends an op and materialises it through `applyOp`,
// so local edits and pulled ops share one code path (design/002).
import { migrate } from './schema';
import { beats, between, titleFromBody, type Stamp } from './ops';
import type { Db, Item, ItemChange, ItemFields, Note, NoteKind, NoteSummary, Op, OpKind, Version } from './types';

type Stamps = Record<string, Stamp>;

const parseStamps = (json: string | null | undefined): Stamps => (json ? JSON.parse(json) : {});
const stampOf = (op: { lamport: number; device: string }): Stamp => ({ l: op.lamport, d: op.device });

// ---------------------------------------------------------------- database setup

export function openDb(db: Db, device?: string): string {
  migrate(db);
  // WAL + NORMAL: the default rollback journal fsyncs twice per commit, which is what a single
  // item write was paying for. WAL keeps SQLite's own multi-tab locking intact.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  const existing = meta(db, 'device');
  if (existing) return existing;
  const id = device ?? crypto.randomUUID();
  setMetaValue(db, 'device', id);
  setMetaValue(db, 'lamport', '0');
  setMetaValue(db, 'seq', '0');
  return id;
}

export function deviceId(db: Db): string {
  return meta(db, 'device') ?? '';
}

function meta(db: Db, key: string): string | undefined {
  return db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value;
}

function setMetaValue(db: Db, key: string, value: string): void {
  db.run('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    value,
  ]);
}

function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------- op log

function appendOp(db: Db, kind: OpKind, noteId: string, payload: Record<string, unknown>): Op {
  const device = deviceId(db);
  const lamport = Number(meta(db, 'lamport') ?? '0') + 1;
  const seq = Number(meta(db, 'seq') ?? '0') + 1;
  const created = Date.now();
  setMetaValue(db, 'lamport', String(lamport));
  setMetaValue(db, 'seq', String(seq));

  const op: Op = { device, seq, kind, note_id: noteId, lamport, created, payload };
  db.run('INSERT INTO op(device, seq, kind, note_id, payload, lamport, created, pushed) VALUES(?,?,?,?,?,?,?,0)', [
    device,
    seq,
    kind,
    noteId,
    JSON.stringify(payload),
    lamport,
    created,
  ]);
  applyOp(db, op);
  return op;
}

/** The single materialisation entry point: local writes and pulled ops both land here. */
export function applyOp(db: Db, op: Op): void {
  if (op.kind === 'note_meta') applyNoteMeta(db, op);
  else if (op.kind === 'note_snapshot') applySnapshot(db, op);
  else if (op.kind === 'todo_item') applyTodoOp(db, op as Op & { payload: ItemChange });
  else throw new Error(`unknown op kind ${op.kind}`);
}

/** Apply an op that came from elsewhere; idempotent by `(device, seq)`. */
export function applyRemoteOp(db: Db, op: Op): boolean {
  const seen = db.get('SELECT 1 FROM op_seen WHERE device = ? AND seq = ?', [op.device, op.seq]);
  if (seen) return false;
  db.run('INSERT INTO op_seen(device, seq) VALUES(?, ?)', [op.device, op.seq]);
  applyOp(db, op);
  return true;
}

function applyNoteMeta(db: Db, op: Op): void {
  const { kind, title, tags, deleted } = op.payload as {
    kind: NoteKind;
    title?: string;
    tags?: string[];
    deleted?: boolean;
  };
  const row = db.get<Note>('SELECT * FROM note WHERE id = ?', [op.note_id]);
  const stamps = parseStamps(row?.stamps);
  const next = { ...stamps, meta: stampOf(op) };

  if (!row) {
    db.run(
      'INSERT INTO note(id, kind, title, body, created, updated, deleted, stamps) VALUES(?,?,?,?,?,?,?,?)',
      [op.note_id, kind, title ?? '', '', op.created, op.created, deleted ? 1 : 0, JSON.stringify(next)],
    );
  } else if (beats(stampOf(op), stamps.meta)) {
    db.run('UPDATE note SET title = ?, deleted = ?, updated = ?, stamps = ? WHERE id = ?', [
      title ?? row.title,
      deleted === undefined ? row.deleted : deleted ? 1 : 0,
      op.created,
      JSON.stringify(next),
      op.note_id,
    ]);
  } else {
    return;
  }

  if (tags) {
    db.run('DELETE FROM note_tag WHERE note_id = ?', [op.note_id]);
    for (const name of tags) {
      db.run('INSERT INTO tag(name) VALUES(?) ON CONFLICT(name) DO NOTHING', [name]);
      db.run('INSERT INTO note_tag(note_id, name) VALUES(?, ?) ON CONFLICT DO NOTHING', [op.note_id, name]);
    }
  }
}

function applySnapshot(db: Db, op: Op): void {
  const { version_id, parent_version_id, body } = op.payload as {
    version_id: string;
    parent_version_id: string | null;
    body: string;
  };
  db.run(
    'INSERT OR IGNORE INTO version(id, note_id, parent_id, body, lamport, device, created) VALUES(?,?,?,?,?,?,?)',
    [version_id, op.note_id, parent_version_id, body, op.lamport, op.device, op.created],
  );

  const row = db.get<Note>('SELECT * FROM note WHERE id = ?', [op.note_id]);
  if (!row) throw new Error(`snapshot for unknown note ${op.note_id}`);
  const stamps = parseStamps(row.stamps);
  if (!beats(stampOf(op), stamps.body)) return;

  db.run('UPDATE note SET body = ?, title = ?, updated = ?, stamps = ? WHERE id = ?', [
    body,
    row.kind === 'note' ? titleFromBody(body) : row.title,
    op.created,
    JSON.stringify({ ...stamps, body: stampOf(op) }),
    op.note_id,
  ]);
}

function applyTodoOp(db: Db, op: Op & { payload: ItemChange }): void {
  const change: ItemChange = { ...op.payload, lamport: op.lamport, device: op.device, created: op.created };
  // Item changes are changes to the list: recency and the "edited" label must follow them.
  db.run('UPDATE note SET updated = ? WHERE id = ? AND updated < ?', [op.created, change.note_id, op.created]);
  db.run(
    `INSERT OR IGNORE INTO todo_item_op(device, seq, item_id, note_id, fields, lamport, created)
     VALUES(?,?,?,?,?,?,?)`,
    [op.device, op.seq, change.item_id, change.note_id, JSON.stringify(change.fields), op.lamport, op.created],
  );

  const row = db.get<Item>('SELECT * FROM todo_item WHERE id = ?', [change.item_id]);
  const stamps = parseStamps(row?.stamps);
  const fields = change.fields;
  const applied: Record<string, unknown> = {};

  for (const field of ['text', 'done', 'ordering', 'deleted', 'depth'] as const) {
    const value = fields[field];
    if (value === undefined) continue;
    if (!beats(stampOf(op), stamps[field])) continue;
    applied[field] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    stamps[field] = stampOf(op);
  }

  if (!row) {
    db.run(
      `INSERT INTO todo_item(id, note_id, text, done, ordering, depth, deleted, updated, stamps)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        change.item_id,
        change.note_id,
        (applied.text as string) ?? '',
        (applied.done as number) ?? 0,
        (applied.ordering as number) ?? 0,
        (applied.depth as number) ?? 0,
        (applied.deleted as number) ?? 0,
        op.created,
        JSON.stringify(stamps),
      ],
    );
    return;
  }

  if (Object.keys(applied).length === 0) return;
  db.run(
    `UPDATE todo_item SET text = ?, done = ?, ordering = ?, depth = ?, deleted = ?, updated = ?, stamps = ?
     WHERE id = ?`,
    [
      (applied.text as string) ?? row.text,
      (applied.done as number) ?? row.done,
      (applied.ordering as number) ?? row.ordering,
      (applied.depth as number) ?? row.depth,
      (applied.deleted as number) ?? row.deleted,
      Math.max(row.updated, op.created),
      JSON.stringify(stamps),
      change.item_id,
    ],
  );
}

// ---------------------------------------------------------------- local writes

export function createNote(db: Db, kind: NoteKind, title = ''): string {
  const id = crypto.randomUUID();
  return tx(db, () => {
    appendOp(db, 'note_meta', id, { kind, title, tags: [], deleted: false });
    return id;
  });
}

/** Writes a snapshot only when the body differs from the current one; returns whether it wrote. */
export function saveBody(db: Db, noteId: string, body: string, versionId = crypto.randomUUID()): boolean {
  return tx(db, () => {
    const note = db.get<Note>('SELECT * FROM note WHERE id = ?', [noteId]);
    if (!note) throw new Error(`unknown note ${noteId}`);
    if (note.kind !== 'note') throw new Error(`note ${noteId} is a ${note.kind}`);
    if (note.body === body) return false;
    appendOp(db, 'note_snapshot', noteId, {
      version_id: versionId,
      parent_version_id: headVersionId(db, noteId),
      body,
    });
    return true;
  });
}

export function setNoteMeta(
  db: Db,
  noteId: string,
  change: { title?: string; tags?: string[]; deleted?: boolean },
): void {
  tx(db, () => {
    const note = db.get<Note>('SELECT * FROM note WHERE id = ?', [noteId]);
    if (!note) throw new Error(`unknown note ${noteId}`);
    const tags = change.tags ?? tagsOf(db, noteId);
    appendOp(db, 'note_meta', noteId, {
      kind: note.kind,
      title: change.title ?? note.title,
      tags,
      deleted: change.deleted ?? note.deleted === 1,
    });
  });
}

/** Restoring is an ordinary edit: a new snapshot whose parent is the current head. */
export function restoreVersion(db: Db, noteId: string, versionId: string): boolean {
  const version = db.get<Version>('SELECT * FROM version WHERE id = ? AND note_id = ?', [versionId, noteId]);
  if (!version) throw new Error(`unknown version ${versionId}`);
  return saveBody(db, noteId, version.body);
}

export function addItem(
  db: Db,
  noteId: string,
  text: string,
  itemId: string = crypto.randomUUID(),
  depth = 0,
  ordering?: number,
): string {
  tx(db, () => {
    const last = db.get<{ ordering: number | null }>(
      'SELECT max(ordering) AS ordering FROM todo_item WHERE note_id = ? AND deleted = 0',
      [noteId],
    );
    appendOp(db, 'todo_item', noteId, {
      item_id: itemId,
      note_id: noteId,
      fields: { text, done: false, deleted: false, depth, ordering: ordering ?? between(last?.ordering ?? null, null) },
    });
  });
  return itemId;
}

export function toggleItem(db: Db, itemId: string): void {
  const item = mustItem(db, itemId);
  changeItem(db, item, { done: !item.done });
}

export function setItemText(db: Db, itemId: string, text: string): void {
  const item = mustItem(db, itemId);
  if (item.text === text) return;
  changeItem(db, item, { text });
}

export function setItemDepth(db: Db, itemId: string, depth: number): void {
  const item = mustItem(db, itemId);
  if (item.depth === depth) return;
  changeItem(db, item, { depth });
}

export function removeItem(db: Db, itemId: string): void {
  const item = mustItem(db, itemId);
  changeItem(db, item, { deleted: true });
}

function changeItem(db: Db, item: Item, fields: ItemFields): void {
  tx(db, () => {
    appendOp(db, 'todo_item', item.note_id, { item_id: item.id, note_id: item.note_id, fields });
  });
}

function mustItem(db: Db, itemId: string): Item {
  const item = db.get<Item>('SELECT * FROM todo_item WHERE id = ?', [itemId]);
  if (!item) throw new Error(`unknown item ${itemId}`);
  return item;
}

// ---------------------------------------------------------------- reads

export function getNote(db: Db, noteId: string): Note | undefined {
  return db.get<Note>('SELECT * FROM note WHERE id = ?', [noteId]);
}

export function listNotes(db: Db, filter: { tag?: string; q?: string; kind?: NoteKind } = {}): NoteSummary[] {
  const where = ['n.deleted = 0'];
  const params: unknown[] = [];
  if (filter.kind) {
    where.push('n.kind = ?');
    params.push(filter.kind);
  }
  if (filter.tag) {
    where.push('EXISTS(SELECT 1 FROM note_tag t WHERE t.note_id = n.id AND t.name = ?)');
    params.push(filter.tag);
  }
  if (filter.q) {
    const like = `%${filter.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    where.push(`(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\' OR EXISTS(
      SELECT 1 FROM todo_item i WHERE i.note_id = n.id AND i.deleted = 0 AND i.text LIKE ? ESCAPE '\\'))`);
    params.push(like, like, like);
  }
  return db.all<NoteSummary>(
    `SELECT n.*,
       (SELECT count(*) FROM todo_item i WHERE i.note_id = n.id AND i.deleted = 0 AND i.done = 0) AS open_items,
       (SELECT count(*) FROM todo_item i WHERE i.note_id = n.id AND i.deleted = 0) AS item_count
     FROM note n WHERE ${where.join(' AND ')} ORDER BY n.updated DESC`,
    params,
  );
}

export function versions(db: Db, noteId: string): Version[] {
  return db.all<Version>(
    'SELECT * FROM version WHERE note_id = ? ORDER BY lamport DESC, device DESC',
    [noteId],
  );
}

/** Leaves of the version tree: versions nobody points at. More than one means a conflict. */
export function heads(db: Db, noteId: string): Version[] {
  return db.all<Version>(
    `SELECT * FROM version v WHERE v.note_id = ?
       AND NOT EXISTS (SELECT 1 FROM version c WHERE c.parent_id = v.id)
     ORDER BY v.lamport DESC, v.device DESC`,
    [noteId],
  );
}

function headVersionId(db: Db, noteId: string): string | null {
  const head = db.get<{ id: string }>(
    `SELECT v.id FROM version v WHERE v.note_id = ?
       AND NOT EXISTS (SELECT 1 FROM version c WHERE c.parent_id = v.id)
     ORDER BY v.lamport DESC, v.device DESC LIMIT 1`,
    [noteId],
  );
  return head?.id ?? null;
}

export function items(db: Db, noteId: string, showDone = false): Item[] {
  return db.all<Item>(
    `SELECT * FROM todo_item WHERE note_id = ? AND deleted = 0 ${showDone ? '' : 'AND done = 0'}
     ORDER BY ordering`,
    [noteId],
  );
}

export function itemHistory(db: Db, itemId: string): { fields: string; lamport: number; device: string; created: number }[] {
  return db.all(
    'SELECT fields, lamport, device, created FROM todo_item_op WHERE item_id = ? ORDER BY lamport DESC, device DESC',
    [itemId],
  );
}

export function tags(db: Db): string[] {
  return db.all<{ name: string }>('SELECT name FROM tag ORDER BY name').map((t) => t.name);
}

export function tagsOf(db: Db, noteId: string): string[] {
  return db.all<{ name: string }>('SELECT name FROM note_tag WHERE note_id = ? ORDER BY name', [noteId]).map(
    (t) => t.name,
  );
}

export function unpushed(db: Db, limit = 200): Op[] {
  return db
    .all<{ device: string; seq: number; kind: OpKind; note_id: string; payload: string; lamport: number; created: number }>(
      'SELECT * FROM op WHERE pushed = 0 ORDER BY device, seq LIMIT ?',
      [limit],
    )
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

// ---------------------------------------------------------------- debug reads

/** Whitelisted, read-only: the debug overlay never gets arbitrary SQL. */
const DEBUG_TABLES = [
  'note', 'version', 'todo_item', 'todo_item_op', 'tag', 'note_tag', 'op', 'op_seen', 'sync_state', 'meta',
] as const;

const DEBUG_ORDER: Record<string, string> = {
  note: 'updated DESC',
  version: 'lamport DESC, device DESC',
  todo_item: 'note_id, ordering',
  todo_item_op: 'lamport DESC, device DESC',
  op: 'device, seq DESC',
};

export type DebugTable = { name: string; count: number };
export type DebugPage = { columns: string[]; rows: Record<string, unknown>[]; total: number };

export function debugTables(db: Db): DebugTable[] {
  return DEBUG_TABLES.map((name) => ({
    name,
    count: db.get<{ n: number }>(`SELECT count(*) AS n FROM ${name}`)?.n ?? 0,
  }));
}

export function debugRows(db: Db, table: string, offset = 0, limit = 100): DebugPage {
  if (!DEBUG_TABLES.includes(table as (typeof DEBUG_TABLES)[number])) throw new Error(`unknown table ${table}`);
  const order = DEBUG_ORDER[table] ?? 'rowid';
  const columns = db
    .all<{ name: string }>('SELECT name FROM pragma_table_info(?)', [table])
    .map((c) => c.name);
  const rows = db.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY ${order} LIMIT ? OFFSET ?`, [
    limit,
    offset,
  ]);
  const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0;
  return { columns, rows, total };
}

export function markPushed(db: Db, ops: { device: string; seq: number }[]): void {
  tx(db, () => {
    for (const op of ops) db.run('UPDATE op SET pushed = 1 WHERE device = ? AND seq = ?', [op.device, op.seq]);
  });
}
