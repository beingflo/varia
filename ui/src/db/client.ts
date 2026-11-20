// Main-thread proxy. Every write notifies this tab's own listeners and pings the other tabs, so
// views (and the sync trigger) never depend on a BroadcastChannel echo that never arrives.
import type { Handlers, Repo } from './api';

// Data writes only: sync bookkeeping (`markPushed`, `applyRemotePage`) must not look like a local edit,
// or every sync would schedule the next one.
const WRITES = new Set<keyof Handlers>([
  'createNote', 'saveBody', 'setNoteMeta', 'addItem', 'toggleItem', 'setItemText', 'setItemDepth',
  'removeItem', 'applyRemote',
]);

export function createClient(worker: Worker, channel = new BroadcastChannel('varia')): Repo & { onChange(fn: () => void): void } {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  const listeners = new Set<() => void>();

  // A dead worker must be visible, not a page that silently shows an empty database.
  let fatal: Error | null = null;
  worker.onerror = (event) => {
    fatal = new Error(`database worker failed: ${event.message || 'unknown error'}`);
    for (const call of pending.values()) call.reject(fatal);
    pending.clear();
    listeners.forEach((fn) => fn());
  };

  worker.onmessage = ({ data }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const call = pending.get(data.id);
    if (!call) return;
    pending.delete(data.id);
    data.error ? call.reject(new Error(data.error)) : call.resolve(data.result);
  };

  channel.onmessage = () => listeners.forEach((fn) => fn());

  function call<T>(method: keyof Handlers, args: unknown[]): Promise<T> {
    if (fatal) return Promise.reject(fatal);
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ id, method, args });
    }).then((result) => {
      // A write that reports `false` wrote nothing (an unchanged body, a stale restore): no ping.
      if (WRITES.has(method) && result !== false) {
        // BroadcastChannel does not deliver to the sender, so the local listeners are called here.
        listeners.forEach((fn) => fn());
        channel.postMessage(method);
      }
      return result;
    });
  }

  const repo = {} as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of [
    'deviceId', 'listNotes', 'getNote', 'createNote', 'saveBody', 'setNoteMeta', 'versions', 'versionBody',
    'heads', 'items', 'addItem', 'toggleItem', 'setItemText', 'setItemDepth', 'removeItem', 'itemHistory',
    'tags', 'tagsOf', 'unpushed', 'markPushed', 'applyRemote', 'syncCursor', 'resetCursor', 'applyRemotePage', 'resetSync',
    'debugTables', 'debugRows',
  ] as (keyof Handlers)[]) {
    repo[method] = (...args) => call(method, args);
  }

  return Object.assign(repo as unknown as Repo, {
    get error() {
      return fatal;
    },
    onChange(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
}
