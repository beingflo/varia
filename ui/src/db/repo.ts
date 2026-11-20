// Local-first data layer. Every write appends an op and materialises it through `applyOp`,
// so local edits and pulled ops share one code path (design/002).
import { migrate } from './schema';
import { beats, between, tagsOfLastLine, titleFromBody, type Stamp } from './ops';
import type { NoteFilter } from './api';
import type {
  Db, Item, ItemChange, ItemFields, Note, NoteKind, NoteSummary, Op, OpKind, Version, VersionHead, VersionMeta, VersionPair,
} from './types';

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
  // Bodies written before tags were indexed still carry tag lines nobody derived: one pass, once.
  if (!meta(db, 'tags_indexed')) {
    tx(db, () => {
      for (const note of db.all<{ id: string; body: string }>('SELECT id, body FROM note')) {
        writeTags(db, note.id, note.body);
      }
      setMetaValue(db, 'tags_indexed', '1');
    });
  }
  const existing = meta(db, 'device');
  if (existing) return existing;
  const id = device ?? crypto.randomUUID();
  setMetaValue(db, 'device', id);
  setMetaValue(db, 'lamport', '0');
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

/**
 * `note_tag` is an index over the body, never a second source of truth: the tag line is the input
 * and deleting that line untags the note. Both paths that write a body call this, so a snapshot
 * pulled from another device re-derives exactly like a local save.
 */
function writeTags(db: Db, noteId: string, body: string): void {
  db.run('DELETE FROM note_tag WHERE note_id = ?', [noteId]);
  for (const name of tagsOfLastLine(body)) {
    db.run('INSERT INTO tag(name) VALUES(?) ON CONFLICT(name) DO NOTHING', [name]);
    db.run('INSERT INTO note_tag(note_id, name) VALUES(?, ?) ON CONFLICT DO NOTHING', [noteId, name]);
  }
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

/** Text compresses to at least ~6 bits per character, so a payload up to this size always stays
 *  under the server's 4 MB ciphertext limit per op — and an op the server would reject could pin
 *  the outbox. Rejected at the boundary, not filtered out later. */
const MAX_OP_PAYLOAD = 4_500_000;

function appendOp(db: Db, kind: OpKind, noteId: string, payload: Record<string, unknown>): Op {
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_OP_PAYLOAD) throw new Error('this change is too large to sync (over 4 MB)');
  const device = deviceId(db);
  const lamport = Number(meta(db, 'lamport') ?? '0') + 1;
  const created = Date.now();
  setMetaValue(db, 'lamport', String(lamport));

  const op: Op = { id: crypto.randomUUID(), device, kind, note_id: noteId, lamport, created, payload };
  db.run('INSERT INTO op(id, device, kind, note_id, payload, lamport, created, pushed) VALUES(?,?,?,?,?,?,?,0)', [
    op.id,
    device,
    kind,
    noteId,
    serialized,
    lamport,
    created,
  ]);
  applyOp(db, op);
  return op;
}

/** The kinds this client applies. Anything else came from a newer one. */
const KNOWN_KINDS = new Set<string>(['note_meta', 'note_snapshot', 'todo_item']);

/** The single materialisation entry point: local writes and pulled ops both land here. */
export function applyOp(db: Db, op: Op): void {
  if (op.kind === 'note_meta') applyNoteMeta(db, op);
  else if (op.kind === 'note_snapshot') applySnapshot(db, op);
  else if (op.kind === 'todo_item') applyTodoOp(db, op as Op & { payload: ItemChange });
  else throw new Error(`unknown op kind ${op.kind}`);
}

/** Applies a whole pulled page in one transaction: one commit per batch, not per op. */
export function applyRemoteOps(db: Db, ops: Op[]): number {
  return tx(db, () => ops.reduce((applied, op) => (applyRemoteOp(db, op) ? applied + 1 : applied), 0));
}

/** Apply an op that came from elsewhere; idempotent by op id. */
export function applyRemoteOp(db: Db, op: Op): boolean {
  // The local clock must pass the remote one, or the next local write loses the tie-break.
  if (op.lamport > Number(meta(db, 'lamport') ?? '0')) setMetaValue(db, 'lamport', String(op.lamport));
  // A kind from a newer client: skip it, and deliberately not through `op_seen`, so this device
  // applies it once it knows the kind (after an upgrade, or a repair that re-pulls the log).
  if (!KNOWN_KINDS.has(op.kind)) return false;
  const seen = db.get('SELECT 1 FROM op_seen WHERE id = ?', [op.id]);
  if (seen) return false;
  try {
    applyOp(db, op);
  } catch (err) {
    // shortcut: one op that cannot apply (a snapshot whose note never arrived) must not roll
    // back the page and pin the cursor; it stays unseen, so a repair retries it once it can
    console.warn('skipped an op that failed to apply', op.kind, op.note_id, err);
    return false;
  }
  db.run('INSERT INTO op_seen(id) VALUES(?)', [op.id]);
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
  writeTags(db, op.note_id, body);
}

function applyTodoOp(db: Db, op: Op & { payload: ItemChange }): void {
  const change: ItemChange = { ...op.payload, lamport: op.lamport, device: op.device, created: op.created };
  // Item changes are changes to the list: recency and the "edited" label must follow them.
  db.run('UPDATE note SET updated = ? WHERE id = ? AND updated < ?', [op.created, change.note_id, op.created]);
  db.run(
    `INSERT OR IGNORE INTO todo_item_op(id, device, item_id, note_id, fields, lamport, created)
     VALUES(?,?,?,?,?,?,?)`,
    [op.id, op.device, change.item_id, change.note_id, JSON.stringify(change.fields), op.lamport, op.created],
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
export function saveBody(db: Db, noteId: string, body: string): boolean {
  return tx(db, () => {
    const note = db.get<Note>('SELECT * FROM note WHERE id = ?', [noteId]);
    if (!note) throw new Error(`unknown note ${noteId}`);
    if (note.kind !== 'note') throw new Error(`note ${noteId} is a ${note.kind}`);
    if (note.body === body) return false;
    appendOp(db, 'note_snapshot', noteId, {
      version_id: crypto.randomUUID(),
      parent_version_id: headVersionId(db, noteId),
      body,
    });
    writeTags(db, noteId, body);
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

/** Shared by the list and the count, so a filter cannot mean two different things. */
function noteWhere(filter: NoteFilter): { clause: string; params: unknown[] } {
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
  if (filter.excludeTag) {
    where.push('NOT EXISTS(SELECT 1 FROM note_tag t WHERE t.note_id = n.id AND t.name = ?)');
    params.push(filter.excludeTag);
  }
  if (filter.q) {
    const like = `%${filter.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    where.push(`(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\' OR EXISTS(
      SELECT 1 FROM todo_item i WHERE i.note_id = n.id AND i.deleted = 0 AND i.text LIKE ? ESCAPE '\\'))`);
    params.push(like, like, like);
  }
  return { clause: where.join(' AND '), params };
}

export function listNotes(db: Db, filter: NoteFilter = {}): NoteSummary[] {
  const { clause, params } = noteWhere(filter);
  return db.all<NoteSummary>(
    `SELECT n.*,
       (SELECT count(*) FROM todo_item i WHERE i.note_id = n.id AND i.deleted = 0 AND i.done = 0) AS open_items,
       (SELECT count(*) FROM todo_item i WHERE i.note_id = n.id AND i.deleted = 0) AS item_count
     FROM note n WHERE ${clause} ${
       filter.sort === 'created' ? 'ORDER BY n.created DESC, n.id DESC' : 'ORDER BY n.updated DESC'
     }${filter.limit ? ' LIMIT ?' : ''}`,
    filter.limit ? [...params, filter.limit] : params,
  );
}

export function countNotes(db: Db, filter: NoteFilter = {}): number {
  const { clause, params } = noteWhere(filter);
  return db.get<{ n: number }>(`SELECT count(*) AS n FROM note n WHERE ${clause}`, params)?.n ?? 0;
}

export function versions(db: Db, noteId: string): VersionMeta[] {
  return db.all<VersionMeta>(
    // No body here: history rows only need the shape of the tree, and a long note would otherwise
    // read every version's text just to list ids.
    `SELECT id, parent_id, lamport, device, created
       FROM version WHERE note_id = ? ORDER BY lamport DESC, device DESC`,
    [noteId],
  );
}

/** One version's full body, for the preview-free history screen: loaded only when needed. */
/**
 * One version and the body it was written from, in one read: the history pane shows both the text
 * and the diff against its parent, and the parent is what makes the two a single query.
 */
export function versionPair(db: Db, noteId: string, versionId: string): VersionPair | undefined {
  const row = db.get<{ body: string; parent_id: string | null }>(
    'SELECT body, parent_id FROM version WHERE id = ? AND note_id = ?',
    [versionId, noteId],
  );
  if (!row) return undefined;
  const parent = row.parent_id ? db.get<{ body: string }>('SELECT body FROM version WHERE id = ?', [row.parent_id]) : undefined;
  return { body: row.body, parentBody: parent?.body ?? null };
}

/** Leaves of the version tree: versions nobody points at. More than one means a conflict. */
export function heads(db: Db, noteId: string): VersionHead[] {
  return db.all<VersionHead>(
    `SELECT v.id, v.lamport, v.device, v.created FROM version v WHERE v.note_id = ?
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

export function unpushed(db: Db, limit = 500): Op[] {
  return db
    .all<{ id: string; device: string; kind: OpKind; note_id: string; payload: string; lamport: number; created: number }>(
      // Insert order, not wall clock: a clock stepped backwards between a note's meta and its
      // snapshot must not push the child before its parent (recipients would skip both).
      'SELECT * FROM op WHERE pushed = 0 ORDER BY rowid LIMIT ?',
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
  op: 'created DESC, rowid DESC',
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

export function syncCursor(db: Db, account: string): number {
  return meta(db, 'cursor_account') === account ? Number(meta(db, 'cursor') ?? '0') : 0;
}

/**
 * Forgets the sync account without touching a single note: the log becomes the outbox again, so the
 * whole local history can be pushed to a new account.
 */
export function resetSync(db: Db): void {
  tx(db, () => {
    db.run('UPDATE op SET pushed = 0');
    db.run('DELETE FROM op_seen');
    setMetaValue(db, 'cursor', '0');
    setMetaValue(db, 'cursor_account', '');
    // `sync_account` survives: it says whose history the pulled notes came from, so rejoining
    // that same account knows the provenance is already up there.
  });
}

/**
 * The outbox holds only this device's own ops, so an op for a note that arrived via pull would
 * reach a different account without the meta that created it — and a snapshot without its note
 * would be skipped by every recipient, losing the edit. Before the log is pushed to another
 * account (`enrol`, `signup`), append the provenance the new account needs: the note's current
 * meta, its body when no local snapshot carries it, and the current fields of any item the
 * outbox edits. The fresh lamports make the synthetic ops win on a device that has not seen the
 * note; the ops they beat are exactly the history they replace.
 */
export function adoptForeignNotes(db: Db, target: string): void {
  tx(db, () => {
    if (meta(db, 'sync_account') === target) return; // rejoining: the provenance is already there
    const touched = new Map<string, { meta: boolean; snapshot: boolean; items: Set<string> }>();
    for (const row of db.all<{ note_id: string; kind: OpKind; payload: string }>(
      'SELECT note_id, kind, payload FROM op',
    )) {
      const entry = touched.get(row.note_id) ?? { meta: false, snapshot: false, items: new Set<string>() };
      if (row.kind === 'note_meta') entry.meta = true;
      if (row.kind === 'note_snapshot') entry.snapshot = true;
      if (row.kind === 'todo_item') {
        const change = JSON.parse(row.payload) as { item_id?: string };
        if (change.item_id) entry.items.add(change.item_id);
      }
      touched.set(row.note_id, entry);
    }
    for (const [noteId, entry] of touched) {
      if (entry.meta) continue; // this device created the note: its provenance is in the log
      const note = db.get<Note>('SELECT * FROM note WHERE id = ?', [noteId]);
      if (!note) continue;
      appendOp(db, 'note_meta', noteId, {
        kind: note.kind,
        title: note.title,
        tags: tagsOf(db, noteId),
        deleted: note.deleted === 1,
      });
      // Always, even when the outbox carries snapshots of its own: they precede this meta in
      // push order, so on a fresh device they are skipped for arriving before the note exists.
      if (note.kind === 'note' && note.body) {
        appendOp(db, 'note_snapshot', noteId, {
          version_id: crypto.randomUUID(),
          parent_version_id: headVersionId(db, noteId),
          body: note.body,
        });
      }
      for (const itemId of entry.items) {
        const item = db.get<Item>('SELECT * FROM todo_item WHERE id = ?', [itemId]);
        if (!item) continue;
        appendOp(db, 'todo_item', noteId, {
          item_id: itemId,
          note_id: noteId,
          fields: { text: item.text, done: item.done === 1, deleted: item.deleted === 1, depth: item.depth, ordering: item.ordering },
        });
      }
    }
  });
}

/**
 * Deletes every note and its whole history, keeping the device id: the same installation, emptied.
 * The server's log is untouched, so agreeing to sync the account again brings it all back.
 */
export function purge(db: Db): void {
  tx(db, () => {
    // Children before parents: `version`, `todo_item` and `note_tag` reference `note`.
    for (const table of ['todo_item_op', 'todo_item', 'version', 'note_tag', 'tag', 'op', 'op_seen', 'sync_state', 'note']) {
      db.run(`DELETE FROM ${table}`);
    }
    setMetaValue(db, 'cursor', '0');
    setMetaValue(db, 'cursor_account', '');
    setMetaValue(db, 'sync_account', '');
  });
}

/**
 * Applies a pulled page and advances the pull cursor in one transaction, so the two can never
 * disagree: a crash cannot leave the cursor ahead of the ops it stands for.
 */
/**
 * Forgets the pull position of one account, keeping every op and its pushed flag: the next sync
 * re-pulls the whole log, which fills any hole a skipped op left behind. Applying is idempotent.
 */
export function resetCursor(db: Db, account: string): void {
  tx(db, () => {
    if (meta(db, 'cursor_account') !== account) return;
    setMetaValue(db, 'cursor', '0');
  });
}

export function applyRemotePage(db: Db, ops: Op[], cursor: number, account: string): number {
  return tx(db, () => {
    let applied = 0;
    for (const op of ops) if (applyRemoteOp(db, op)) applied += 1;
    setMetaValue(db, 'cursor', String(Math.max(cursor, syncCursor(db, account))));
    setMetaValue(db, 'cursor_account', account);
    setMetaValue(db, 'sync_account', account);
    return applied;
  });
}

export function markPushed(db: Db, ops: { id: string }[]): void {
  tx(db, () => {
    for (const op of ops) db.run('UPDATE op SET pushed = 1 WHERE id = ?', [op.id]);
  });
}
