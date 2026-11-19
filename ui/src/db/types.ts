/** The three things the data layer needs from a database. Adapters: sqlite-wasm in the
 *  client worker, `node:sqlite` in tests. */
export interface Db {
  exec(sql: string): void;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  run(sql: string, params?: unknown[]): void;
}

export type NoteKind = 'note' | 'todo';
export type OpKind = 'note_meta' | 'note_snapshot' | 'todo_item';

export interface Op {
  device: string;
  seq: number;
  kind: OpKind;
  note_id: string;
  lamport: number;
  created: number;
  payload: Record<string, unknown>;
}

export interface Note {
  id: string;
  kind: NoteKind;
  title: string;
  body: string;
  created: number;
  updated: number;
  deleted: number;
  /** Per-channel last-writer stamps: `{meta: {l, d}, body: {l, d}}`. */
  stamps: string;
}

export interface NoteSummary extends Note {
  open_items: number;
  item_count: number;
}

export interface Version {
  id: string;
  note_id: string;
  parent_id: string | null;
  body: string;
  lamport: number;
  device: string;
  created: number;
}

export interface Item {
  id: string;
  note_id: string;
  text: string;
  done: number;
  ordering: number;
  /** 0 = top level; children are the following rows with a greater depth. */
  depth: number;
  deleted: number;
  updated: number;
  /** Per-field last-writer stamps, same shape as `Note.stamps`. */
  stamps: string;
}

/** Ops carry flags as booleans; materialisation stores them as 0/1. */
export interface ItemFields {
  text?: string;
  done?: boolean;
  deleted?: boolean;
  ordering?: number;
  depth?: number;
}

export interface ItemChange {
  item_id: string;
  note_id: string;
  fields: ItemFields;
  lamport: number;
  device: string;
  created: number;
}
