// Shared harness for the sync audit suites (guarantees.test.ts, scenarios.test.ts):
// a fake /api/sync that mirrors server/src/app.rs + store.rs as closely as a test double can.
import { formatRootKey, newRootKey, opKey } from './crypto';
import type { SyncResponse, Transport, WireOp } from './client';
import { SyncError } from './http';
import type { Account, AccountStore } from './keystore';
import { createHandlers } from '../db/handlers';
import { nodeDb } from '../db/nodeSqlite';
import { openDb } from '../db/repo';
import type { Repo } from '../db/api';
import type { Db } from '../db/types';

const MAX_OP_BYTES = 4 * 1024 * 1024;

type Log = { stored: (WireOp & { server_seq: number })[]; seen: Set<string> };

export type AuditServer = {
  transport: Transport;
  /** Every call, oldest first: what token the client believed it was serving. */
  calls: { token: string; cursor: number; ops: number }[];
  logOf: (token: string) => Log;
  usageOf: (log: Log) => number;
  /** Mutable, so a test can fill an account mid-scenario. */
  cfg: { cap: number; pageSize: number };
};

/**
 * Mirrors the real /api/sync: one log per account (token), dedupe on op id,
 * the whole request rejected when any op is oversized, cap checked during push,
 * and the pull discarded on a cap hit. Pull floor and head exactly as in app.rs.
 */
export function auditServer(cfg: { cap?: number; pageSize?: number } = {}): AuditServer {
  const logs = new Map<string, Log>();
  const logOf = (token: string) => {
    let log = logs.get(token);
    if (!log) logs.set(token, (log = { stored: [], seen: new Set() }));
    return log;
  };
  const usageOf = (log: Log) => log.stored.reduce((n, op) => n + Math.floor((op.ciphertext.length * 3) / 4), 0);
  const server: AuditServer = {
    calls: [],
    logOf,
    usageOf,
    cfg: { cap: cfg.cap ?? 500 * 1024 * 1024, pageSize: cfg.pageSize ?? 2000 },
    transport: async (token, { cursor, ops }) => {
      server.calls.push({ token, cursor, ops: ops.length });
      const log = logOf(token);
      // app.rs validates every op of the request before storing anything.
      for (const op of ops) {
        if (Math.floor((op.ciphertext.length * 3) / 4) > MAX_OP_BYTES) throw new SyncError(413, 'op_too_large');
      }
      // app.rs: duplicates never trip the cap; a full account accepts a prefix of the push,
      // and the pull always happens.
      const base = log.stored.length;
      let accepted = 0;
      for (const op of ops) {
        if (log.seen.has(op.id)) {
          accepted += 1;
          continue;
        }
        if (usageOf(log) + Math.floor((op.ciphertext.length * 3) / 4) > server.cfg.cap) break;
        log.seen.add(op.id);
        log.stored.push({ ...op, server_seq: log.stored.length + 1 });
        accepted += 1;
      }

      const written = log.stored.length;
      const floor = cursor >= base ? Math.max(cursor, written) : cursor;
      const page = log.stored.filter((op) => op.server_seq > floor).slice(0, server.cfg.pageSize);
      const last = page.at(-1)?.server_seq ?? floor;
      return {
        ops: page,
        cursor: last,
        head: log.stored.length,
        accepted,
        more: log.stored.some((op) => op.server_seq > last),
        usage_bytes: usageOf(log),
        cap_bytes: server.cfg.cap,
      } satisfies SyncResponse;
    },
  };
  return server;
}

export function memoryStore(): AccountStore & { current?: Account } {
  const store: AccountStore & { current?: Account } = {
    load: async () => store.current,
    save: async (account) => {
      store.current = account;
    },
    clear: async () => {
      store.current = undefined;
    },
  };
  return store;
}

/** A fresh account: token plus the root key in both raw and copied form. */
export async function freshAccount(token: string) {
  const root = newRootKey();
  return { token, root, key: await opKey(root), keyText: formatRootKey(root) };
}

/** Poll until `condition` holds; fails the scenario instead of hanging when it never does. */
export async function waitFor(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !(await condition()); i += 1) await new Promise((r) => setTimeout(r, 5));
  if (!(await condition())) throw new Error(`timed out waiting for ${what}`);
}

/** A transport whose next call is held until the test releases it (a stalled server). */
export function heldTransport(inner: Transport) {
  let hold = false;
  let release!: (r: SyncResponse) => void;
  const held = new Promise<SyncResponse>((res) => (release = res));
  let called = false;
  const transport: Transport = async (token, body) => {
    if (hold) {
      hold = false;
      called = true;
      return held;
    }
    return inner(token, body);
  };
  return {
    transport,
    /** Arm the hold; the next call will stall. */
    arm: () => {
      hold = true;
    },
    /** Wait until the held call has actually reached the transport. */
    inFlight: () => waitFor(() => called, 'the stalled request to be in flight'),
    release,
  };
}

/** The test repo with its raw database exposed, for seeding rows the public surface cannot write. */
export function testRepoWithDb(device: string) {
  const db: Db = nodeDb();
  openDb(db, device);
  const handlers = createHandlers(db);
  const repo = {} as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const [method, fn] of Object.entries(handlers)) {
    repo[method] = async (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args);
  }
  return { repo: repo as unknown as Repo, db };
}
