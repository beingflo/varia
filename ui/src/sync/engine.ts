// The sync loop and what the UI is allowed to know about it. Every trigger is best-effort:
// failures are counted, never thrown at the caller, and the next trigger tries again.
import { createSignal } from 'solid-js';
import type { Repo } from '../db/api';
import { flushAll } from '../lib/flush';
import { accountTag, formatRootKey, newRootKey, opKey, openSealed, parseRootKey } from './crypto';
import { syncNow } from './client';
import { httpTransport, SyncError } from './http';
import type { Account, AccountStore } from './keystore';

export type SyncStatus = {
  state: 'off' | 'syncing' | 'idle' | 'error';
  pending: number;
  last: number;
  usage: number;
  cap: number;
  /** Changes over the wire limit: they stay pending and are shown, never dropped silently. */
  oversized: number;
  error: string;
};

const PULL_EVERY = 60_000;
/** Fallback backoff for a failure that does not say how long to wait. */
const RETRY_SECONDS = 30;

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
  const [status, setStatus] = createSignal<SyncStatus>({
    state: 'off', pending: 0, last: 0, usage: 0, cap: 0, oversized: 0, error: '',
  });
  const [enrolled, setEnrolled] = createSignal(false);
  /** The backend token, for the panel to show. The key is never held after signup. */
  const [accountToken, setAccountToken] = createSignal('');

  let account: Account | undefined;
  let running = false;
  let current: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
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

  /** Waits for a sync already in flight, chained runs included. Account switches must not race one. */
  async function idle(): Promise<void> {
    while (running) await current;
  }

  /** One push-then-pull round trip. Never throws; the status carries what happened. */
  async function run(reason: string): Promise<void> {
    if (running) {
      queued = true; // never drop a request made while a sync is in flight
      return current;
    }
    running = true;
    current = (async () => {
      // Another tab may have linked, unlinked or switched the account since the last trigger:
      // the keystore is the truth, not the copy in memory.
      try {
        const loaded = await store.load();
        if (loaded) {
          account = loaded;
        } else if (account) {
          account = undefined;
          setAccountToken('');
          setEnrolled(false);
          patch({ state: 'off', last: 0, pending: 0, oversized: 0, error: '' });
          return; // this tab stops syncing the abandoned account
        } else {
          return;
        }
      } catch {
        if (!account) return; // a storage hiccup: keep the account this session already trusts
      }
      patch({ state: 'syncing' });
      try {
        await flushAll(true); // saved edits become ops before they are pushed, half-typed ones wait
        const result = await syncNow({ repo, key: account!.key, token: account!.token, transport });
        const pending = await pendingCount();
        patch({
          state: 'idle',
          last: Date.now(),
          usage: result.usage,
          cap: result.cap,
          pending,
          oversized: result.oversized,
          error: '',
        });
        // A backlog larger than one round drains by chaining runs; the rate limiter paces it.
        // No chaining without progress, or an unpushcable op would spin the loop.
        if (result.more || result.rewound || (result.pushed > 0 && pending > 0)) queued = true;
      } catch (err) {
        patch({ state: 'error', error: err instanceof Error ? err.message : String(err), pending: await pendingCount() });
        console.warn(`sync failed (${reason})`, err);
        // Rate limited or offline: try again on our own instead of waiting for the next trigger.
        const wait = err instanceof SyncError && err.retryAfter ? err.retryAfter : RETRY_SECONDS;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => void run('retry'), wait * 1000);
      } finally {
        running = false;
        if (queued) {
          queued = false;
          void run('queued');
        }
      }
    })();
    return current;
  }

  async function remember(next: Account): Promise<void> {
    account = next;
    await store.save(next);
    setAccountToken(next.token);
    setEnrolled(true);
    attach();
  }

  /** Creates an account and returns the key once: it is not stored, by design. */
  async function signup(): Promise<{ token: string; key: string }> {
    const response = await fetch(`${base}/api/signup`, { method: 'POST', body: '{}' });
    if (response.status === 404) throw new Error('no sync service at this address (404)');
    if (response.status === 429) {
      const wait = response.headers.get('retry-after');
      throw new Error(`too many signups from this address, try again in ${wait ?? '60'}s`);
    }
    if (!response.ok) throw new Error(`signup failed: ${response.status}`);
    const { token } = (await response.json()) as { token: string };
    const root = newRootKey();
    // A device with a past account (a lost keystore) must carry its whole history over: the same
    // rewind and adoption a join does.
    await idle();
    await repo.resetSync();
    await repo.adoptForeignNotes(await accountTag(token));
    await remember({ token, key: await opKey(root) });
    await run('after signup');
    return { token, key: formatRootKey(root) };
  }

  /** Joins an existing account from its code. The first pull starts at cursor 0: the whole log. */
  async function enrol(token: string, key: string): Promise<void> {
    await idle(); // a sync in flight belongs to the account being left
    const candidate: Account = { token: token.trim(), key: await opKey(parseRootKey(key)) };
    // A wrong key would encrypt this device's whole history into ciphertext nobody can open — and
    // the op-id dedupe on the server would keep the garbage forever. Ask the account first.
    const probe = await transport(candidate.token, { device: await repo.deviceId(), cursor: 0, ops: [] });
    if (probe.ops.length > 0) {
      const sample = probe.ops.slice(0, 8); // a wrong key fails every op, so a few are enough
      const opened = await Promise.allSettled(sample.map((wire) => openSealed(candidate.key, wire.ciphertext)));
      if (opened.every((result) => result.status === 'rejected')) {
        throw new Error('this key does not decrypt this account — check the key and try again');
      }
    }
    // Not enrolled but holding ops marked pushed, or a cursor from some other bucket: a lost
    // keystore. Rewind so this device's history joins the account instead of being silently skipped.
    await repo.resetSync();
    await repo.adoptForeignNotes(await accountTag(candidate.token));
    await remember(candidate);
    await run('after enrolment');
  }

  /**
   * Forgets the account, keeping every note. The op log goes back to being an outbox, so the whole
   * local history can be pushed to a different account afterwards.
   */
  /** Re-pull the account's whole log: idempotent, and the way out of a cursor that skipped an op. */
  async function repair(): Promise<void> {
    const token = accountToken();
    if (!token) return;
    await idle(); // a sync in flight would write its cursor right back over the reset
    await repo.resetCursor(await accountTag(token));
    await run('repair');
  }

  async function unlink(): Promise<void> {
    await idle(); // a push in flight must not mark ops pushed after the rewind
    await store.clear();
    await repo.resetSync();
    account = undefined;
    setAccountToken('');
    setEnrolled(false);
    patch({ state: 'off', last: 0, pending: 0, oversized: 0, error: '' });
    stop();
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
      setAccountToken(account.token);
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
    clearTimeout(retryTimer);
    clearInterval(pullTimer);
    listeners.splice(0).forEach((off) => off());
  }

  return { status, enrolled, token: accountToken, start, stop, run, signup, enrol, unlink, repair, refreshPending };
}
