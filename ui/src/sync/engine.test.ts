// @vitest-environment node
// The loop, with a faked service and an in-memory key store: no network, no IndexedDB.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testRepo } from '../db/inProcess';
import { formatRootKey, newRootKey, opKey } from './crypto';
import { createEngine } from './engine';
import type { Account, AccountStore } from './keystore';
import type { Transport, WireOp } from './client';

function memoryStore(): AccountStore & { current?: Account } {
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

/** A fake service: keeps every op, hands back what a cursor has not seen, never echoes a push. */
function fakeService() {
  const stored: (WireOp & { server_seq: number })[] = [];
  const seen = new Set<string>();
  const transport: Transport = async (_token, { cursor, ops }) => {
    let written = 0;
    for (const op of ops) {
      const key = op.id;
      if (seen.has(key)) continue;
      seen.add(key);
      stored.push({ ...op, server_seq: stored.length + 1 });
      written = stored.length;
    }
    const floor = Math.max(cursor, written);
    const page = stored.filter((op) => op.server_seq > floor);
    return {
      ops: page,
      cursor: page.at(-1)?.server_seq ?? floor,
      more: false,
      usage_bytes: stored.length * 64,
      cap_bytes: 500 * 1024 * 1024,
    };
  };
  return { transport, stored };
}

async function accountFor(token = 'token-from-signup') {
  const root = newRootKey();
  return { account: { token, key: await opKey(root) } as Account, root, keyText: formatRootKey(root), token };
}

/** A repo that is already enrolled, so `run` has a key and a token. */
async function enrolledEngine(service: ReturnType<typeof fakeService>, device = 'device-a') {
  const { account, token, keyText } = await accountFor();
  const repo = testRepo(device);
  const store = memoryStore();
  store.current = account;
  const engine = createEngine({ repo, store, transport: service.transport });
  await engine.enrol(token, keyText);
  return { repo, engine, store };
}

describe('sync engine', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.useRealTimers());

  it('creates an account, shows a code that works, and pushes what is on screen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: 'tok-1' }), { status: 200 })));
    const service = fakeService();
    const repo = testRepo('device-a');
    const engine = createEngine({ repo, store: memoryStore(), transport: service.transport });
    const id = await repo.createNote('note');
    await repo.saveBody(id, '# first\nbody');

    const created = await engine.signup();
    expect(created.token).toBe('tok-1');
    expect(created.key).toHaveLength(52);

    expect(engine.enrolled()).toBe(true);
    expect(engine.status()).toMatchObject({ state: 'idle', pending: 0 });
    expect(await repo.unpushed()).toHaveLength(0);
    expect(service.stored).toHaveLength(2);
  });

  it('enrols from a code and pulls the whole log into an empty database', async () => {
    const service = fakeService();
    const { token, keyText, account } = await accountFor();
    const source = testRepo('device-a');
    const writer = createEngine({ repo: source, store: memoryStore(), transport: service.transport });
    await writer.enrol(token, keyText);
    const id = await source.createNote('note');
    await source.saveBody(id, '# moved\nacross devices');
    await writer.run('test');
    expect(service.stored).toHaveLength(2);

    const receiver = testRepo('device-b');
    const engine = createEngine({ repo: receiver, store: memoryStore(), transport: service.transport });
    await engine.enrol(token, keyText);
    expect(account.token).toBe('token-from-signup');

    expect(engine.status().state).toBe('idle');
    expect((await receiver.getNote(id))?.body).toBe('# moved\nacross devices');
  });

  it('reports a failure without losing the outbox', async () => {
    const { token, keyText } = await accountFor();
    const repo = testRepo('device-a');
    await repo.createNote('note');
    const engine = createEngine({
      repo,
      store: memoryStore(),
      transport: async () => Promise.reject(new Error('offline')),
    });

    await engine.enrol(token, keyText); // the enrolment pull is the failing call

    expect(engine.status().state).toBe('error');
    expect(engine.status().error).toContain('offline');
    expect(engine.status().pending).toBe(1);
    expect(await repo.unpushed()).toHaveLength(1);
  });

  it('coalesces a burst of writes into one push instead of one request per op', async () => {
    const service = fakeService();
    const { repo, engine } = await enrolledEngine(service);
    const id = await repo.createNote('note');

    // Three writes fired back to back, as three `run` calls would be: the first one syncs, the
    // others queue behind it and are served by a single follow-up.
    for (const body of ['one', 'two', 'three']) {
      await repo.saveBody(id, body);
      void engine.run('after a write');
    }
    await new Promise((r) => setTimeout(r, 300));

    expect(service.stored).toHaveLength(4); // one note_meta and three snapshots
    expect(await repo.unpushed()).toHaveLength(0);
    expect(engine.status().pending).toBe(0);
  });

  it('shows the token later but never the key again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: 'tok-keep' }), { status: 200 })));
    const store = memoryStore();
    const engine = createEngine({ repo: testRepo('device-a'), store, transport: fakeService().transport });
    const created = await engine.signup();
    expect(created).toEqual({ token: 'tok-keep', key: created.key });
    expect(engine.token()).toBe('tok-keep');

    // Only the token and the derived key are stored: no root bytes anywhere.
    expect(Object.keys(store.current!).sort()).toEqual(['key', 'token']);

    const restarted = createEngine({ repo: testRepo('device-b'), store, transport: fakeService().transport });
    restarted.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(restarted.token()).toBe('tok-keep');
    restarted.stop();
  });

  it('unlinks the account and turns the whole log back into an outbox for the next one', async () => {
    const service = fakeService();
    const { repo, engine, store } = await enrolledEngine(service);
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'kept locally');
    await engine.run('test'); // no change listeners on the in-process repo: push explicitly
    expect(await repo.unpushed()).toHaveLength(0);

    await engine.unlink();

    expect(engine.enrolled()).toBe(false);
    expect(engine.token()).toBe('');
    expect(store.current).toBeUndefined();
    // The notes are untouched; everything becomes pushable again and the cursor restarts.
    expect((await repo.getNote(id))?.body).toBe('kept locally');
    expect(await repo.unpushed()).toHaveLength(2);
    expect(await repo.syncCursor()).toBe(0);

    // A new account receives the entire local history on its first push.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: 'tok-2' }), { status: 200 })));
    const fresh = fakeService();
    const rejoined = createEngine({ repo, store, transport: fresh.transport });
    await rejoined.signup();
    expect(fresh.stored).toHaveLength(2);
    expect(await repo.unpushed()).toHaveLength(0);
  });

  it('starts from a stored account and is off without one', async () => {
    const service = fakeService();
    const store = memoryStore();
    const repo = testRepo('device-a');
    const idle = createEngine({ repo, store, transport: service.transport });
    idle.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(idle.enrolled()).toBe(false);
    expect(idle.status().state).toBe('off');

    store.current = (await accountFor()).account;
    const engine = createEngine({ repo: testRepo('device-a'), store, transport: service.transport });
    engine.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.enrolled()).toBe(true);
    expect(engine.status().state).toBe('idle');
    engine.stop();
    idle.stop();
  });
});
