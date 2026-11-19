// Test adapter: Node's built-in SQLite (same version as the wasm build). Never bundled.
import { DatabaseSync } from 'node:sqlite';
import type { Db } from './types';

export function nodeDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as never,
    get: (sql, params = []) => db.prepare(sql).get(...(params as never[])) as never,
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
  };
}
