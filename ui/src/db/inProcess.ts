// Test adapter: the same handler surface, resolved immediately, on a Node in-memory database.
import type { Handlers, Repo } from './api';
import { createHandlers } from './handlers';
import { nodeDb } from './nodeSqlite';
import { openDb } from './repo';

export function testRepo(device = 'dev-test'): Repo {
  const db = nodeDb();
  openDb(db, device);
  const handlers = createHandlers(db);
  const repo = {} as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const [method, fn] of Object.entries(handlers)) {
    repo[method] = async (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args);
  }
  return repo as unknown as Repo;
}

export type { Handlers };
