// The only place that opens the database. SQLite's own locking keeps multiple tabs safe.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createHandlers } from './handlers';
import { openDb } from './repo';
import type { Db } from './types';

type Request = { id: number; method: string; args: unknown[] };

let handlers: ReturnType<typeof createHandlers> | null = null;
// Boot fires several calls before the wasm has loaded; each one would otherwise start its own
// init — a second connection, a second openDb, and a window where the lamport clock resets to 0.
let ready: Promise<void> | null = null;
const ensureReady = () => (ready ??= init());

async function init(): Promise<void> {
  const sqlite3 = await sqlite3InitModule();
  const raw = new sqlite3.oo1.OpfsDb('/varia.sqlite3');
  const db: Db = {
    exec: (sql) => raw.exec(sql),
    all: (sql, params = []) => raw.selectObjects(sql, params as never) as never,
    get: (sql, params = []) => (raw.selectObjects(sql, params as never) as never[])[0] as never,
    run: (sql, params = []) => {
      raw.exec({ sql, bind: params as never });
    },
  };
  openDb(db);
  handlers = createHandlers(db);
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    if (!handlers) await ensureReady();
    const handler = (handlers as unknown as Record<string, (...args: unknown[]) => unknown>)[data.method];
    if (!handler) throw new Error(`unknown method ${data.method}`);
    self.postMessage({ id: data.id, result: handler(...data.args) });
  } catch (err) {
    self.postMessage({ id: data.id, error: `${(err as Error).message ?? err}` });
  }
};
