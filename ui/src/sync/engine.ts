// The sync loop and what the UI is allowed to know about it. Every trigger is best-effort:
// failures are counted, never thrown at the caller, and the next trigger tries again.
import { createSignal } from 'solid-js';
import type { Repo } from '../db/api';
import { flushAll } from '../lib/flush';
import { enrolmentCode, newRootKey, opKey, parseEnrolmentCode } from './crypto';
import { syncNow } from './client';
import { httpTransport } from './http';
import type { Account, AccountStore } from './keystore';

export type SyncStatus = {
  state: 'off' | 'syncing' | 'idle' | 'error';
  pending: number;
  last: number;
  usage: number;
  cap: number;
  error: string;
};

const PULL_EVERY = 60_000;

export type Engine = ReturnType<typeof createEngine>;

export function createEngine(options: {
  repo: Repo;
  store: AccountStore;
  /** Origin of the service; empty means the one the app was served from. */
  base?: string;
  transport?: ReturnType<typeof httpTransport>;
}) {
  const { repo, store } = options;
  const base = options.base ?? '';
  const transport = options.transport ?? httpTransport(base);
  const [status, setStatus] = createSignal<SyncStatus>({ state: 'off', pending: 0, last: 0, usage: 0, cap: 0, error: '' });
  const [enrolled, setEnrolled] = createSignal(false);

  let account: Account | undefined;
  let running = false;
  let pullTimer: ReturnType<typeof setInterval> | undefined;
  let attached = false;
  let queued = false;
  const listeners: (() => void)[] = [];

  const patch = (change: Partial<SyncStatus>) => setStatus({ ...status(), ...change });

  async function pendingCount(): Promise<number> {
    return (await repo.unpushed()).length;
  }

  async function refreshPending(): Promise<void> {
    patch({ pending: await pendingCount() });
  }

  /** One push-then-pull round trip. Never throws; the status carries what happened. */
  async function run(reason: string): Promise<void> {
    if (!account) return;
    if (running) {
      queued = true; // never drop a request made while a sync is in flight
      return;
    }
    running = true;
    patch({ state: 'syncing' });
    try {
      await flushAll(); // unsaved edits become ops before they are pushed
      const result = await syncNow({ repo, key: account.key, token: account.token, transport });
      patch({
        state: 'idle',
        last: Date.now(),
        usage: result.usage,
        cap: result.cap,
        pending: await pendingCount(),
        error: '',
      });
    } catch (err) {
      patch({ state: 'error', error: err instanceof Error ? err.message : String(err), pending: await pendingCount() });
      console.warn(`sync failed (${reason})`, err);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void run('queued');
      }
    }
  }

  /** Creates an account and returns the enrolment code, which is the only time it can be shown. */
  async function signup(): Promise<string> {
    const response = await fetch(`${base}/api/signup`, { method: 'POST', body: '{}' });
    if (response.status === 404) throw new Error('no sync service at this address (404)');
    if (response.status === 429) {
      const wait = response.headers.get('retry-after');
      throw new Error(`too many signups from this address, try again in ${wait ?? '60'}s`);
    }
    if (!response.ok) throw new Error(`signup failed: ${response.status}`);
    const { token } = (await response.json()) as { token: string };
    const root = newRootKey();
    account = { token, key: await opKey(root) };
    await store.save(account);
    setEnrolled(true);
    attach();
    await run('after signup');
    return enrolmentCode(token, root);
  }

  /** Joins an existing account from its code. The first pull starts at cursor 0: the whole log. */
  async function enrol(code: string): Promise<void> {
    const { token, root } = parseEnrolmentCode(code);
    account = { token, key: await opKey(root) };
    await store.save(account);
    setEnrolled(true);
    attach();
    await run('after enrolment');
  }

  // Tests run without a DOM; a browser always has one.
  const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

  function start(): void {
    void (async () => {
      try {
        account = await store.load();
      } catch (err) {
        console.warn('sync storage unavailable', err); // private mode, disabled storage
        return;
      }
      setEnrolled(Boolean(account));
      if (!account) return;
      attach();
      await run('on start');
    })();
  }

  /** Timers and listeners. Called again after enrolling: a fresh session had nothing to attach to. */
  function attach(): void {
    if (attached) return;
    attached = true;
    pullTimer = setInterval(() => {
      if (visible()) void run('timer');
    }, PULL_EVERY);
    if (typeof document !== 'undefined') {
      const onVisibility = () => void run(visible() ? 'foreground' : 'hidden');
      document.addEventListener('visibilitychange', onVisibility);
      listeners.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }
    // Writes from this tab and from other tabs. A write during a run is remembered as one follow-up,
    // never as a request per op.
    const off = repo.onChange?.(() => {
      if (running) queued = true;
      else void run('after a write');
    });
    if (off) listeners.push(off);
  }

  function stop(): void {
    attached = false;
    clearInterval(pullTimer);
    listeners.splice(0).forEach((off) => off());
  }

  return { status, enrolled, start, stop, run, signup, enrol, refreshPending };
}
