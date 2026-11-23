// The one surface views are allowed to touch: no SQL, no connection, just calls.
import type {
  Db, ImportedNote, Item, ItemChange, ItemFields, Note, NoteKind, NoteSummary, Op, SearchHit, SearchPage, Version, VersionHead, VersionMeta, VersionPair,
} from './types';

/** `sort: 'created'` is a journal's chronology; the default stays "what did I touch last". */
export type NoteFilter = {
  tag?: string;
  excludeTag?: string;
  /** Search terms; only `searchNotes` reads it. */
  q?: string;
  kind?: NoteKind;
  sort?: 'created';
  limit?: number;
};
export type DebugTable = { name: string; count: number };
export type DebugPage = { columns: string[]; rows: Record<string, unknown>[]; total: number };
/** What the debug overlay's search probe reports: `hits`/`ms`/`plan` only for a query with terms. */
export type DebugSearch = {
  notes: number;
  indexed: number;
  duplicates: number;
  hits: number | null;
  ms: number | null;
  plan: string[];
};

/** Synchronous implementation, used inside the worker and directly in tests. */
export interface Handlers {
  deviceId(): string;
  listNotes(filter?: NoteFilter): NoteSummary[];
  countNotes(filter?: NoteFilter): number;
  searchNotes(filter?: NoteFilter): SearchPage;
  getNote(id: string): Note | undefined;
  createNote(kind: NoteKind, title?: string): string;
  saveBody(noteId: string, body: string): boolean;
  importNotes(notes: ImportedNote[]): number;
  setNoteMeta(noteId: string, change: { title?: string; tags?: string[]; deleted?: boolean }): void;
  versions(noteId: string): VersionMeta[];
  versionPair(noteId: string, versionId: string): VersionPair | undefined;
  heads(noteId: string): VersionHead[];
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
  syncCursor(account: string): number;
  resetCursor(account: string): void;
  applyRemotePage(ops: Op[], cursor: number, account: string): number;
  resetSync(): void;
  /** Append the provenance ops pulled notes need before their history joins another account. */
  adoptForeignNotes(target: string): void;
  /** Delete every note and its history on this device. */
  purge(): void;
  debugTables(): DebugTable[];
  debugRows(table: string, offset?: number, limit?: number): DebugPage;
  debugSearch(filter?: NoteFilter): DebugSearch;
}

/** What views call: the same calls, asynchronous, across the worker boundary. */
export type Repo = { [K in keyof Handlers]: (...args: Parameters<Handlers[K]>) => Promise<ReturnType<Handlers[K]>> } & {
  /** Notify when another tab wrote; absent for the in-process test repo. */
  onChange?(fn: () => void): () => void;
  /** Set when the worker died; views should show it instead of an empty database. */
  readonly error?: Error | null;
};

export type { Db, ImportedNote, Item, ItemChange, ItemFields, Note, NoteKind, NoteSummary, Op, SearchHit, SearchPage, Version, VersionHead, VersionMeta };
