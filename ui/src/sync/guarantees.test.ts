// @vitest-environment node
// Invariants that hold today and must keep holding: committed local data is never lost to a
// crash, a retry, an offline period, a clock step, a full account, a wrong key or an account
// switch. Every test here asserts the GOOD outcome — if one starts failing, a fix regressed a
// guarantee. The harness in testing.ts mirrors server/src/app.rs + store.rs; no network needed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testRepo } from '../db/inProcess';
import { accountTag, opKey, parseRootKey, seal } from './crypto';
import { syncNow } from './client';
import { auditServer, freshAccount, heldTransport, memoryStore, testRepoWithDb, waitFor } from './testing';
import { createEngine } from './engine';
import { SyncError } from './http';
import { tokenFingerprint } from './crypto';

describe('guarantees', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('a push whose response is lost is retried harmlessly: no loss, no duplicates', async () => {
    const server = auditServer();
    const { key } = await freshAccount('t');
    const repoA = testRepo('a');
    const id = await repoA.createNote('note');
    await repoA.saveBody(id, 'the user typed this');

    // The server accepted and stored the push, but the response never reached the client:
    // the tab died between "stored" and "marked pushed". The outbox must still be intact.
    let answered = false;
    const dropOnce: Parameters<typeof syncNow>[0]['transport'] = async (token, body) => {
      const response = await server.transport(token, body);
      if (!answered) {
        answered = true;
        throw new Error('connection lost after the server stored the ops');
      }
      return response;
    };
    await expect(syncNow({ repo: repoA, key, token: 't', transport: dropOnce })).rejects.toThrow('connection lost');
    expect((await repoA.unpushed()).length).toBe(2);

    // The retry re-pushes everything; the server dedupes on the op id, and the other device
    // still ends up with exactly one note and both ops applied.
    const result = await syncNow({ repo: repoA, key, token: 't', transport: dropOnce });
    expect(result.pushed).toBe(2);
    expect(server.logOf('t').stored.length).toBe(2);

    const repoB = testRepo('b');
    await syncNow({ repo: repoB, key, token: 't', transport: server.transport });
    expect((await repoB.getNote(id))?.body).toBe('the user typed this');
    expect(await repoB.versions(id)).toHaveLength(1);
  });

  it('switching accounts: the old cursor never leaks, and the old log follows as history', async () => {
    const server = auditServer();
    const x = await freshAccount('t-x');
    const y = await freshAccount('t-y');

    // X: A creates a note. B enrols, writes its own note, syncs (cursor moves past 0).
    const repoA = testRepo('a');
    const idX = await repoA.createNote('note');
    await repoA.saveBody(idX, 'on X');
    await syncNow({ repo: repoA, key: x.key, token: x.token, transport: server.transport });
    const repoB = testRepo('b');
    const engineB = createEngine({ repo: repoB, store: memoryStore(), transport: server.transport });
    await engineB.enrol(x.token, x.keyText);
    const idB = await repoB.createNote('note');
    await repoB.saveBody(idB, "B's own note");
    await engineB.run('manual');
    expect(await repoB.syncCursor(await accountTag(x.token))).toBe(4); // X's log fully pulled

    // Y is seeded independently by another device.
    const repoD = testRepo('d');
    const idY = await repoD.createNote('note');
    await repoD.saveBody(idY, 'on Y');
    await syncNow({ repo: repoD, key: y.key, token: y.token, transport: server.transport });

    // B switches to Y. The old cursor (4) must not apply: B pulls Y's whole log from 0.
    await engineB.unlink();
    await engineB.enrol(y.token, y.keyText);
    expect(await repoB.getNote(idY)).toBeDefined();
    // Y's log is D's 2 ops plus B's whole log: its own 2 and the 2 it had pulled from X. The log
    // moved with the device, so the old cursor applied nowhere.
    expect(await repoB.syncCursor(await accountTag(y.token))).toBe(6);
    expect(await repoB.syncCursor(await accountTag(x.token))).toBe(0); // X's cursor cannot leak back

    // A's ops themselves follow the device: same ids, same authors, so Y holds X's version history
    // rather than a synthesised copy of its current state.
    const yLog = server.logOf(y.token).stored;
    expect(yLog.filter((op) => op.note_id === idX).map((op) => op.id)).toEqual(
      server.logOf(x.token).stored.filter((op) => op.note_id === idX).map((op) => op.id),
    );
    expect(yLog.filter((op) => op.note_id === idB).length).toBe(2);
  });

  it('a server that lost the account log gets the whole history pushed back', async () => {
    // The device is the only copy after a recreated volume: the cursor is ahead of the head, so
    // the device rewinds and re-pushes instead of sitting on a log nobody else can see.
    const account = await freshAccount('t');
    const repo = testRepo('a');
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'the device holds the only copy now');
    await syncNow({ repo, key: account.key, token: account.token, transport: auditServer().transport });
    expect((await repo.unpushed()).length).toBe(0);

    const wiped = auditServer();
    const result = await syncNow({ repo, key: account.key, token: account.token, transport: wiped.transport });
    expect(result.rewound).toBe(true);
    expect(wiped.logOf(account.token).stored.length).toBe(2);
    expect((await repo.unpushed()).length).toBe(0);

    // And an empty device gets the whole history back.
    const repoB = testRepo('b');
    await syncNow({ repo: repoB, key: account.key, token: account.token, transport: wiped.transport });
    expect((await repoB.getNote(id))?.body).toBe('the device holds the only copy now');
  });

  it('a wrong key is rejected at enrolment, before anything is pushed', async () => {
    const server = auditServer();
    const x = await freshAccount('t-x');
    const repoA = testRepo('a');
    const idX = await repoA.createNote('note');
    await repoA.saveBody(idX, 'note A body');
    await syncNow({ repo: repoA, key: x.key, token: x.token, transport: server.transport });

    // A one-character typo in the 52 base32 characters still parses as 32 bytes, so the probe
    // is what has to catch it — and it must, because the op-id dedupe would keep a wrong-key
    // push on the server forever.
    const b = await freshAccount('t-x');
    const typo = b.keyText.slice(0, 3) + (b.keyText[3] === 'A' ? 'B' : 'A') + b.keyText.slice(4);
    const repoB = testRepo('b');
    const engineB = createEngine({ repo: repoB, store: memoryStore(), transport: server.transport });
    await expect(engineB.enrol(x.token, typo)).rejects.toThrow('this key does not decrypt this account');

    // Nothing was remembered, nothing was pushed: the account is exactly as it was.
    expect(engineB.enrolled()).toBe(false);
    expect(server.logOf(x.token).stored.filter((op) => op.device === 'b')).toHaveLength(0);

    // The correct key still works, and a fresh device gets everything.
    await engineB.enrol(x.token, x.keyText);
    const repoC = testRepo('c');
    const rc = await syncNow({ repo: repoC, key: x.key, token: x.token, transport: server.transport });
    expect(rc.skipped).toBe(0);
    expect(await repoC.getNote(idX)).toBeDefined();
  });

  it('a backward clock step does not reorder the outbox: parents always push before children', async () => {
    const server = auditServer();
    const { key } = await freshAccount('t');
    const repoA = testRepo('a');
    const real = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real);
    const id = await repoA.createNote('note'); // meta created = real
    spy.mockReturnValue(real - 600_000); // NTP steps the clock back 10 minutes
    await repoA.saveBody(id, 'written after the step'); // snapshot created = real - 10 min
    spy.mockRestore();

    // Insert order, not wall clock: the meta still precedes its snapshot.
    expect((await repoA.unpushed()).map((op) => op.kind)).toEqual(['note_meta', 'note_snapshot']);

    await syncNow({ repo: repoA, key, token: 't', transport: server.transport });
    const repoB = testRepo('b');
    await syncNow({ repo: repoB, key, token: 't', transport: server.transport });
    expect((await repoB.getNote(id))?.body).toBe('written after the step');
  });

  it('one op that cannot apply is skipped, not fatal: the sync continues', async () => {
    const server = auditServer();
    const { key } = await freshAccount('t');
    const repoA = testRepo('a');
    const broken = await repoA.createNote('note');
    await repoA.saveBody(broken, 'its meta blob will be damaged on the server');
    const healthy = await repoA.createNote('note');
    await repoA.saveBody(healthy, 'must still arrive');
    await syncNow({ repo: repoA, key, token: 't', transport: server.transport });

    // A single damaged blob on the server (bad disk, bad backup): the meta fails to open, so its
    // snapshot cannot apply. That must cost the one note — never the whole sync.
    server.logOf('t').stored.find((op) => op.note_id === broken)!.ciphertext = 'AAAAAAAA';

    const repoB = testRepo('b');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await syncNow({ repo: repoB, key, token: 't', transport: server.transport });
    expect(warn).toHaveBeenCalledWith('skipped an op that failed to apply', 'note_snapshot', broken, expect.any(Error));
    expect(result.skipped).toBe(1); // the damaged meta
    expect((await repoB.getNote(healthy))?.body).toBe('must still arrive');
    expect(await repoB.getNote(broken)).toBeUndefined(); // the data is gone at the source
    // And it stays healthy on every later sync.
    const again = await syncNow({ repo: repoB, key, token: 't', transport: server.transport });
    expect(again.pulled).toBe(0);
  });

  it('a full account accepts a prefix and still pulls: devices are never split off', async () => {
    const server = auditServer();
    const { key } = await freshAccount('t');
    const repoA = testRepo('a');
    const repoB = testRepo('b');
    const id1 = await repoA.createNote('note');
    await repoA.saveBody(id1, 'first');
    await syncNow({ repo: repoA, key, token: 't', transport: server.transport });
    await syncNow({ repo: repoB, key, token: 't', transport: server.transport }); // b is caught up

    // Both write while offline; A's note reaches the server while there is still room.
    const id2 = await repoA.createNote('note');
    await repoA.saveBody(id2, "A's new note");
    await syncNow({ repo: repoA, key, token: 't', transport: server.transport });
    const id3 = await repoB.createNote('note');
    await repoB.saveBody(id3, "B's new note");

    // Room for exactly one of B's two pending ops: the account is full after the first is accepted.
    const pending = await repoB.unpushed();
    const sizes = await Promise.all(pending.map((op) => seal(key, op)));
    const bytes = (sealed: string) => Math.floor((sealed.length * 3) / 4);
    server.cfg.cap =
      server.usageOf(server.logOf('t')) + bytes(sizes[0]) + Math.floor((bytes(sizes[1]) - bytes(sizes[0])) / 2);

    const first = await syncNow({ repo: repoB, key, token: 't', transport: server.transport });
    // The prefix was accepted and marked, A's note arrived in the same response.
    expect(first.pushed).toBe(1);
    expect((await repoB.getNote(id2))?.body).toBe("A's new note");
    expect((await repoB.unpushed()).length).toBe(1); // only the unaccepted rest

    // Retrying the rest when nothing more fits: no error, no split, the data stays local.
    const second = await syncNow({ repo: repoB, key, token: 't', transport: server.transport });
    expect(second.pushed).toBe(0);
    expect((await repoB.unpushed()).length).toBe(1);
    expect((await repoB.getNote(id3))?.body).toBe("B's new note"); // never lost locally
  });

  it('a legacy oversized op never travels but never blocks the outbox behind it', async () => {
    const server = auditServer();
    const { key } = await freshAccount('t');
    const { repo, db } = testRepoWithDb('a');
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'written first, must never be lost');

    // A giant op from before the size guard, sitting in the outbox (raw row: the public
    // surface now refuses to create it).
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let giant = '';
    while (giant.length < 5_600_000) {
      const bytes = crypto.getRandomValues(new Uint8Array(65536));
      giant += Array.from(bytes, (b) => chars[b & 63]).join('');
    }
    db.run(
      'INSERT INTO op(id, device, kind, note_id, payload, lamport, created, pushed) VALUES(?,?,?,?,?,?,?,0)',
      ['giant-op', 'a', 'note_snapshot', id, JSON.stringify({ version_id: 'v', parent_version_id: null, body: giant }), 3, 1],
    );

    const result = await syncNow({ repo, key, token: 't', transport: server.transport });
    // The small ops went up; the giant one was left pending and counted, not dropped.
    expect(result.oversized).toBe(1);
    expect(result.pushed).toBe(2);
    expect(server.logOf('t').stored.length).toBe(2);
    expect((await repo.getNote(id))?.body).toContain('written first');
    expect((await repo.unpushed()).map((op) => op.id)).toEqual(['giant-op']); // only local, never lost

    // And it stays non-blocking on every later sync.
    const again = await syncNow({ repo, key, token: 't', transport: server.transport });
    expect(again.oversized).toBe(1);
    expect(again.pushed).toBe(0);
  });

  it('repair during an in-flight sync waits for it, and the re-pull still starts from zero', async () => {
    const server = auditServer();
    const x = await freshAccount('t');
    const repoA = testRepo('a');
    const id = await repoA.createNote('note');
    await repoA.saveBody(id, 'body');
    await syncNow({ repo: repoA, key: x.key, token: x.token, transport: server.transport });

    const repoB = testRepo('b');
    const held = heldTransport(server.transport);
    const engine = createEngine({ repo: repoB, store: memoryStore(), transport: held.transport });
    await engine.enrol(x.token, x.keyText); // enrolled and synced, cursor at the head
    expect(await repoB.syncCursor(await accountTag(x.token))).toBe(2);

    // A sync is in flight when the user hits "re-pull the log" in the panel.
    held.arm();
    void engine.run('manual');
    await held.inFlight();
    const repairing = engine.repair();
    held.release({ ops: [], cursor: 2, head: 2, more: false, usage_bytes: 0, cap_bytes: 1e9 });
    await repairing;

    // The repair survived the in-flight sync: its pull started from zero, not from the stale
    // run's cursor, and it re-delivered the whole log (idempotently) before settling at the head.
    expect(server.calls.at(-1)).toMatchObject({ cursor: 0 });
    expect(await repoB.syncCursor(await accountTag(x.token))).toBe(2);
    expect((await repoB.getNote(id))?.body).toBe('body');
    await engine.run('manual');
    expect(await repoB.syncCursor(await accountTag(x.token))).toBe(2);
  });

  it('unlink + re-enrol during an in-flight sync: the pending history reaches the NEW account', async () => {
    const server = auditServer();
    const x = await freshAccount('t-x');
    const y = await freshAccount('t-y');
    const repoB = testRepo('b');
    const held = heldTransport(server.transport);
    const engine = createEngine({ repo: repoB, store: memoryStore(), transport: held.transport });
    await engine.enrol(x.token, x.keyText);

    const id = await repoB.createNote('note');
    await repoB.saveBody(id, 'written before unlinking');
    expect((await repoB.unpushed()).length).toBe(2);

    // A push of those ops is in flight (stalled server) while the user switches accounts.
    held.arm();
    void engine.run('after a write');
    await held.inFlight();
    const unlinking = engine.unlink();
    held.release({ ops: [], cursor: 0, head: 2, more: false, usage_bytes: 0, cap_bytes: 1e9 });
    await unlinking;
    await engine.enrol(y.token, y.keyText);

    // The rewind happened after the stale sync finished, so the new account received everything.
    expect((await repoB.unpushed()).length).toBe(0);
    expect(server.logOf(y.token).stored.length).toBe(2);
    expect((await repoB.getNote(id))?.body).toBe('written before unlinking');
  });

  it('a second tab re-reads the keystore: after a switch it syncs the new account, not the old', async () => {
    const server = auditServer();
    const x = await freshAccount('t-x');
    const y = await freshAccount('t-y');
    const repo = testRepo('b');
    const store = memoryStore();
    const tab1 = createEngine({ repo, store, transport: server.transport });
    const tab2 = createEngine({ repo, store, transport: server.transport });

    await tab1.enrol(x.token, x.keyText);
    void tab2.start();
    await waitFor(() => tab2.enrolled(), 'the second tab to load the account');
    await tab2.run('manual');
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'body');
    await tab1.run('manual');
    const callsBefore = server.calls.length;

    // Tab1 switches the account. Tab2 still holds X in memory — the next trigger re-reads.
    await tab1.unlink();
    await tab1.enrol(y.token, y.keyText);
    expect(await repo.syncCursor(await accountTag(y.token))).toBe(2);

    await tab2.run('timer');
    // It synced the account the keystore now holds, and the shared cursor stayed with Y.
    expect(server.calls.slice(callsBefore).every((call) => call.token === y.token)).toBe(true);
    expect(await repo.syncCursor(await accountTag(y.token))).toBe(2);
  });

  it('a large offline backlog drains completely from one trigger, by chaining rounds', async () => {
    const server = auditServer();
    const x = await freshAccount('t');
    const repo = testRepo('a');
    const engine = createEngine({ repo, store: memoryStore(), transport: server.transport });
    await engine.enrol(x.token, x.keyText);
    const id = await repo.createNote('note');
    for (let i = 0; i < 1200; i += 1) await repo.saveBody(id, `line ${i}`);

    await engine.run('manual');
    await waitFor(async () => (await repo.unpushed()).length === 0, 'the backlog to drain');
    expect(server.logOf(x.token).stored.length).toBe(1201); // 1200 snapshots plus the meta op
  });

  it('a library that came down from the old account goes up to the new one whole', async () => {
    // Everything on this device arrived via pull, so its own log is empty and the outbox has
    // nothing to send. The account switch still has to upload what the device holds — notes,
    // bodies and items — or the new account stays empty and every new device sees nothing.
    const server = auditServer();
    const x = await freshAccount('t-x');
    const repoA = testRepo('a');
    const engineA = createEngine({ repo: repoA, store: memoryStore(), transport: server.transport });
    await engineA.enrol(x.token, x.keyText);
    const note = await repoA.createNote('note');
    await repoA.saveBody(note, 'first draft');
    await repoA.saveBody(note, 'only the old account has this');
    const list = await repoA.createNote('todo');
    await repoA.addItem(list, 'buy milk');
    await repoA.addItem(list, 'call mum');
    await engineA.run('manual');
    expect((await repoA.unpushed()).length).toBe(0);

    const repoB = testRepo('b');
    const engineB = createEngine({ repo: repoB, store: memoryStore(), transport: server.transport });
    await engineB.enrol(x.token, x.keyText); // pulled, nothing authored here
    expect((await repoB.unpushed()).length).toBe(0);

    await engineB.unlink();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ token: 't-y' }), { status: 200 }));
    const created = await engineB.signup();
    await engineB.run('manual');
    expect((await repoB.unpushed()).length).toBe(0);

    // A fresh device of the new account gets every note, body and item.
    const repoC = testRepo('c');
    const pulled = await syncNow({
      repo: repoC,
      key: await opKey(parseRootKey(created.key)),
      token: created.token,
      transport: server.transport,
    });
    expect(pulled.skipped).toBe(0);
    expect((await repoC.getNote(note))?.body).toBe('only the old account has this');
    expect((await repoC.items(list)).map((item) => item.text).sort()).toEqual(['buy milk', 'call mum']);
    // The log itself moved, so the version history came with it — not just the current body.
    expect((await repoC.versions(note)).map((version) => version.id)).toEqual(
      (await repoA.versions(note)).map((version) => version.id),
    );
    expect(await repoC.versions(note)).toHaveLength(2);
  });

  it('the meta of a pulled note travels before the ops this device added to it', async () => {
    // This device's own op for a note it pulled has no meta to precede it. Pushed in insert order,
    // a fresh device meets the child first and can never apply it: the meta must travel first.
    const server = auditServer();
    const x = await freshAccount('t-x');
    const repoA = testRepo('a');
    const engineA = createEngine({ repo: repoA, store: memoryStore(), transport: server.transport });
    await engineA.enrol(x.token, x.keyText);
    const list = await repoA.createNote('todo');
    await repoA.addItem(list, 'buy milk');
    await repoA.addItem(list, 'call mum');
    await engineA.run('manual');

    const repoB = testRepo('b');
    const engineB = createEngine({ repo: repoB, store: memoryStore(), transport: server.transport });
    await engineB.enrol(x.token, x.keyText);
    const milk = (await repoB.items(list))[0];
    await repoB.setItemText(milk.id, 'buy oat milk'); // the only op this device authored
    await engineB.unlink();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ token: 't-y' }), { status: 200 }));
    const created = await engineB.signup();
    await engineB.run('manual');

    const sent = server.logOf(created.token).stored.filter((op) => op.note_id === list);
    expect(sent[0]?.kind).toBe('note_meta'); // the note before anything that names it

    const repoC = testRepo('c');
    const pulled = await syncNow({
      repo: repoC,
      key: await opKey(parseRootKey(created.key)),
      token: created.token,
      transport: server.transport,
    });
    expect(pulled.skipped).toBe(0);
    expect((await repoC.items(list)).map((item) => item.text).sort()).toEqual(['buy oat milk', 'call mum']);
  });

  it('switching accounts carries edits of pulled notes: the new account materialises them whole', async () => {
    const server = auditServer();
    const x = await freshAccount('t-x');
    const y = await freshAccount('t-y');

    // A on X creates a note; B, enrolled in X, edits it — a note whose meta lives on X.
    const repoA = testRepo('a');
    const id = await repoA.createNote('note');
    await repoA.saveBody(id, 'A writes on X');
    await syncNow({ repo: repoA, key: x.key, token: x.token, transport: server.transport });
    const repoB = testRepo('b');
    const engineB = createEngine({ repo: repoB, store: memoryStore(), transport: server.transport });
    await engineB.enrol(x.token, x.keyText);
    await repoB.saveBody(id, "B edits A's note");

    // B switches accounts: the log it holds — A's ops included — is pushed to the new one.
    await engineB.unlink();
    await engineB.enrol(y.token, y.keyText);

    // B itself stays healthy, and a fresh device of the new account gets the note complete —
    // no orphan ops, no pinned cursor, no throw.
    await engineB.run('manual');
    expect(engineB.status().state).toBe('idle');
    const repoC = testRepo('c');
    const pulled = await syncNow({ repo: repoC, key: y.key, token: y.token, transport: server.transport });
    expect(pulled.skipped).toBe(0);
    expect((await repoC.getNote(id))?.body).toBe("B edits A's note");
    const again = await syncNow({ repo: repoC, key: y.key, token: y.token, transport: server.transport });
    expect(again.pulled).toBe(0); // and it stays healthy on the next round
  });

  it('signup after a lost keystore pushes the whole local history to the new account', async () => {
    const server = auditServer();
    const x = await freshAccount('t-x');
    const repo = testRepo('b');
    const engine = createEngine({ repo, store: memoryStore(), transport: server.transport });
    await engine.enrol(x.token, x.keyText);
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'the only server copy of this text is on X');
    await engine.run('manual');
    expect((await repo.unpushed()).length).toBe(0);

    // The keystore is lost (cleared IndexedDB, OPFS intact). The overlay offers "create a new
    // account": signup rewinds the outbox the same way enrolment does.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ token: 'tok-new' }), { status: 200 }));
    const engine2 = createEngine({ repo, store: memoryStore(), transport: server.transport });
    const created = await engine2.signup();

    expect(server.logOf(created.token).stored.length).toBe(2);
    expect((await repo.unpushed()).length).toBe(0);
    expect((await repo.getNote(id))?.body).toContain('the only server copy');

    // And a fresh device of the new account receives the history.
    const repoC = testRepo('c');
    await syncNow({
      repo: repoC,
      key: await opKey(parseRootKey(created.key)),
      token: created.token,
      transport: server.transport,
    });
    expect((await repoC.getNote(id))?.body).toContain('the only server copy');
  });

  it('enrols with a token a phone mangled, and says which 401 it was when the server refuses', async () => {
    // A realistic token: 64 lowercase hex characters.
    const account = await freshAccount('3f'.repeat(32));
    const seen: string[] = [];
    const engine = createEngine({
      repo: testRepo('pwa'),
      store: memoryStore(),
      transport: async (token) => {
        seen.push(token);
        throw new SyncError(401, 'unknown_token');
      },
    });

    // iOS capitalises the first character; a share sheet adds spaces and a newline.
    const pasted = ` ${account.token.toUpperCase()}\n`;
    await expect(engine.enrol(pasted, account.keyText)).rejects.toThrow(
      `the server does not know this token (unknown_token)`,
    );
    // The token the server saw is the one that was generated, not the one that was pasted.
    expect(seen[0]).toBe(account.token);
    const message = await engine.enrol(pasted, account.keyText).catch((err: Error) => err.message);
    // The fingerprint is the same six hex characters the server logs, and nothing revealing.
    expect(message).toContain(await tokenFingerprint(account.token));
    expect(message).not.toContain(account.token);
  });
});
