// The one surface views are allowed to touch: no SQL, no connection, just calls.
import type { Db, Item, ItemChange, ItemFields, Note, NoteKind, NoteSummary, Op, Version } from './types';

export type NoteFilter = { tag?: string; q?: string; kind?: NoteKind };
export type DebugTable = { name: string; count: number };
export type DebugPage = { columns: string[]; rows: Record<string, unknown>[]; total: number };

/** Synchronous implementation, used inside the worker and directly in tests. */
export interface Handlers {
  deviceId(): string;
  listNotes(filter?: NoteFilter): NoteSummary[];
  getNote(id: string): Note | undefined;
  createNote(kind: NoteKind, title?: string): string;
  saveBody(noteId: string, body: string): boolean;
  setNoteMeta(noteId: string, change: { title?: string; tags?: string[]; deleted?: boolean }): void;
  versions(noteId: string): Version[];
  heads(noteId: string): Version[];
  restoreVersion(noteId: string, versionId: string): boolean;
  items(noteId: string, showDone?: boolean): Item[];
  addItem(noteId: string, text: string, itemId?: string, depth?: number, ordering?: number): string;
  toggleItem(itemId: string): void;
  setItemText(itemId: string, text: string): void;
  setItemDepth(itemId: string, depth: number): void;
  removeItem(itemId: string): void;
  itemHistory(itemId: string): { fields: string; lamport: number; device: string; created: number }[];
  tags(): string[];
  tagsOf(noteId: string): string[];
  unpushed(): Op[];
  markPushed(ops: { id: string }[]): void;
  applyRemote(ops: Op[]): number;
  syncCursor(): number;
  setSyncCursor(cursor: number): void;
  resetSync(): void;
  debugTables(): DebugTable[];
  debugRows(table: string, offset?: number, limit?: number): DebugPage;
}

/** What views call: the same calls, asynchronous, across the worker boundary. */
export type Repo = { [K in keyof Handlers]: (...args: Parameters<Handlers[K]>) => Promise<ReturnType<Handlers[K]>> } & {
  /** Notify when another tab wrote; absent for the in-process test repo. */
  onChange?(fn: () => void): () => void;
  /** Set when the worker died; views should show it instead of an empty database. */
  readonly error?: Error | null;
};

export type { Db, Item, ItemChange, ItemFields, Note, NoteKind, NoteSummary, Op, Version };
