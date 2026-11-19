// Wiring only: the behaviour lives in repo.ts, so the worker and the tests use the same code.
import type { Handlers } from './api';
import * as repo from './repo';
import type { Db } from './types';

export function createHandlers(db: Db): Handlers {
  return {
    deviceId: () => repo.deviceId(db),
    listNotes: (filter) => repo.listNotes(db, filter),
    getNote: (id) => repo.getNote(db, id),
    createNote: (kind, title) => repo.createNote(db, kind, title),
    saveBody: (noteId, body) => repo.saveBody(db, noteId, body),
    setNoteMeta: (noteId, change) => repo.setNoteMeta(db, noteId, change),
    versions: (noteId) => repo.versions(db, noteId),
    heads: (noteId) => repo.heads(db, noteId),
    restoreVersion: (noteId, versionId) => repo.restoreVersion(db, noteId, versionId),
    items: (noteId, showDone) => repo.items(db, noteId, showDone),
    addItem: (noteId, text, itemId, depth, ordering) => repo.addItem(db, noteId, text, itemId, depth, ordering),
    toggleItem: (itemId) => repo.toggleItem(db, itemId),
    setItemText: (itemId, text) => repo.setItemText(db, itemId, text),
    setItemDepth: (itemId, depth) => repo.setItemDepth(db, itemId, depth),
    removeItem: (itemId) => repo.removeItem(db, itemId),
    itemHistory: (itemId) => repo.itemHistory(db, itemId),
    tags: () => repo.tags(db),
    tagsOf: (noteId) => repo.tagsOf(db, noteId),
    unpushed: () => repo.unpushed(db),
    markPushed: (ops) => repo.markPushed(db, ops),
    applyRemote: (op) => repo.applyRemoteOp(db, op),
    syncCursor: () => repo.syncCursor(db),
    setSyncCursor: (cursor) => repo.setSyncCursor(db, cursor),
    debugTables: () => repo.debugTables(db),
    debugRows: (table, offset, limit) => repo.debugRows(db, table, offset, limit),
  };
}
