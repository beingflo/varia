// @vitest-environment node
// Interleavings of browsers, imports and account states. Each test starts from a state the app
// really reaches — an import landing mid-sync, a purged device, a browser that only ever pulled —
// and asserts that the account and every other browser end up with the same notes and versions.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testRepo } from '../db/inProcess';
import type { Repo } from '../db/api';
import { syncNow } from './client';
import { createEngine, type Engine } from './engine';
import { accountTag, opKey, parseRootKey } from './crypto';
import { auditServer, freshAccount, heldTransport, memoryStore, waitFor, type AuditServer } from './testing';

/** One entry of the fieldnotes conversion: nothing identifies a note but its dates and body. */
const imported = (body: string, at = Date.parse('2020-01-01T00:00:00Z')) => ({
  createdAt: at,
  modifiedAt: at,
  body,
});

type Browser = { repo: Repo; engine: Engine };

/** A browser: its own database, its own keystore, the shared service. */
function browser(server: AuditServer, device = 'a'): Browser {
  const repo = testRepo(device);
  return { repo, engine: createEngine({ repo, store: memoryStore(), transport: server.transport }) };
}

/** Signup answers with a token and nothing else; the key only ever exists in memory. */
async function signupAs(engine: Engine, token: string) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ token }), { status: 200 }));
  return engine.signup();
}

/**
 * Convergence: the app syncs on a write, a capture here does not notify, so every check drives the
 * engine and then waits for the chained rounds (a backlog larger than one call) to settle.
 */
async function drain(b: Browser): Promise<void> {
  await b.engine.run('manual');
  await waitFor(async () => (await b.repo.unpushed()).length === 0, 'the outbox to drain');
}

describe('browsers, imports and account states', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('an import that lands while a push is in flight still reaches the account', async () => {
    const server = auditServer();
    const account = await freshAccount('t');
    const repo = testRepo('a');
    const held = heldTransport(server.transport);
    const engine = createEngine({ repo, store: memoryStore(), transport: held.transport });
    await engine.enrol(account.token, account.keyText);

    const typed = await repo.createNote('note');
    await repo.saveBody(typed, 'typed before the import');
    held.arm();
    void engine.run('manual');
    await held.inFlight();
    // The fieldnotes conversion finishes while that push is stalled.
    await repo.importNotes([imported('## imported\n\nlanded mid-sync')]);
    // The stalled server accepted nothing, so the retry must carry the import too.
    held.release({ ops: [], cursor: 0, head: 0, accepted: 0, more: false, usage_bytes: 0, cap_bytes: 1e9 });
    await drain({ repo, engine });

    const other = browser(server, 'b');
    await other.engine.enrol(account.token, account.keyText);
    expect(await other.repo.countNotes()).toBe(2);
    expect((await other.repo.getNote(typed))?.body).toBe('typed before the import');
    expect((await other.repo.listNotes()).map((n) => n.title).sort()).toEqual([
      'imported',
      'typed before the import',
    ]);
  });

  it('a pulled library plus a fresh import moves to a new account with its history whole', async () => {
    const server = auditServer();
    const x = await freshAccount('t-x');
    const a = browser(server, 'a');
    await a.engine.enrol(x.token, x.keyText);
    const note = await a.repo.createNote('note');
    await a.repo.saveBody(note, 'first version');
    await a.repo.saveBody(note, 'second version');
    await drain(a);

    // B pulls that note (two versions) and imports a file of its own.
    const b = browser(server, 'b');
    await b.engine.enrol(x.token, x.keyText);
    expect(await b.repo.versions(note)).toHaveLength(2);
    await b.repo.importNotes([imported('## carried over\n\nfrom the old account')]);
    await b.engine.unlink();
    const created = await signupAs(b.engine, 't-y');
    await drain(b);

    const c = browser(server, 'c');
    await c.engine.enrol(created.token, created.key);
    expect((await c.repo.versions(note)).map((v) => v.id)).toEqual((await a.repo.versions(note)).map((v) => v.id));
    expect(await c.repo.countNotes()).toBe(2);
  });

  it('two browsers importing the same file end up with both copies and no interference', async () => {
    const server = auditServer();
    const account = await freshAccount('t');
    const a = browser(server, 'a');
    const b = browser(server, 'b');
    await a.engine.enrol(account.token, account.keyText);
    await b.engine.enrol(account.token, account.keyText);

    const file = [imported('## one\n\nsame file'), imported('## two\n\ntwice')];
    await a.repo.importNotes(file);
    await b.repo.importNotes(file); // a fresh id per import, so this is not a duplicate to the log
    await drain(a);
    await drain(b);
    await a.engine.run('manual');
    await b.engine.run('manual');

    // Four notes: each import mints its own ids, and each browser owns its own copy.
    expect(await a.repo.countNotes()).toBe(4);
    expect(await b.repo.countNotes()).toBe(4);
    const fresh = browser(server, 'c');
    await fresh.engine.enrol(account.token, account.keyText);
    expect(await fresh.repo.countNotes()).toBe(4);
  });

  it('an import on one browser arrives on another with its original chronology', async () => {
    const server = auditServer();
    const account = await freshAccount('t');
    const a = browser(server, 'a');
    const b = browser(server, 'b');
    await a.engine.enrol(account.token, account.keyText);
    await b.engine.enrol(account.token, account.keyText);

    await a.repo.importNotes([
      imported('## older entry\n\nfrom 2019', Date.parse('2019-05-01T00:00:00Z')),
      imported('## newer entry\n\nfrom 2021', Date.parse('2021-05-01T00:00:00Z')),
    ]);
    await drain(a);
    await b.engine.run('manual');

    // `created` is the writer's clock and travels with the op, so the journal keeps its order.
    expect((await b.repo.listNotes({ sort: 'created' })).map((n) => n.title)).toEqual(['newer entry', 'older entry']);
    expect((await b.repo.listNotes({ sort: 'created' }))[1].created).toBe(Date.parse('2019-05-01T00:00:00Z'));
  });

  it('a purged device gets its whole history back from the account, versions included', async () => {
    const server = auditServer();
    const account = await freshAccount('t');
    const a = browser(server, 'a');
    await a.engine.enrol(account.token, account.keyText);
    const note = await a.repo.createNote('note');
    await a.repo.saveBody(note, 'one');
    await a.repo.saveBody(note, 'two');
    const list = await a.repo.createNote('todo');
    await a.repo.addItem(list, 'milk');
    await drain(a);
    const versions = (await a.repo.versions(note)).map((v) => v.id);
    const device = await a.repo.deviceId();

    // Sync.tsx: flush, unlink, wipe the rows, reload.
    await a.engine.unlink();
    await a.repo.purge();
    expect(await a.repo.countNotes()).toBe(0);

    await a.engine.enrol(account.token, account.keyText);
    await a.engine.run('manual');
    expect((await a.repo.getNote(note))?.body).toBe('two');
    expect((await a.repo.versions(note)).map((v) => v.id)).toEqual(versions);
    expect((await a.repo.items(list)).map((item) => item.text)).toEqual(['milk']);
    expect(await a.repo.deviceId()).toBe(device); // the same installation, refilled
  });

  it('imports made after unlink still reach the account created afterwards', async () => {
    const server = auditServer();
    const x = await freshAccount('t-x');
    const a = browser(server, 'a');
    await a.engine.enrol(x.token, x.keyText);
    const before = await a.repo.createNote('note');
    await a.repo.saveBody(before, 'written on the old account');
    await drain(a);

    await a.engine.unlink();
    // The user keeps working while the panel is closed, imports included.
    await a.repo.importNotes([imported('## imported while unlinked\n\nstill here')]);
    const created = await signupAs(a.engine, 't-y');
    await drain(a);

    const fresh = browser(server, 'b');
    await fresh.engine.enrol(created.token, created.key);
    expect(await fresh.repo.countNotes()).toBe(2);
    expect((await fresh.repo.getNote(before))?.body).toBe('written on the old account');
    expect((await fresh.repo.listNotes()).map((n) => n.title)).toContain('imported while unlinked');
  });

  it('three browsers with their own histories converge on one account', async () => {
    const server = auditServer();
    const account = await freshAccount('t');
    const a = browser(server, 'a');
    const b = browser(server, 'b');
    const c = browser(server, 'c');

    await a.repo.importNotes([imported('## A one\n\na'), imported('## A two\n\naa')]);
    const bNote = await b.repo.createNote('note');
    await b.repo.saveBody(bNote, 'B typed this');
    await c.repo.importNotes([imported('## C one\n\nccc', Date.parse('2018-01-01T00:00:00Z'))]);

    for (const device of [a, b, c]) await device.engine.enrol(account.token, account.keyText);
    for (const device of [a, b, c]) await device.engine.run('manual');
    for (const device of [a, b, c]) await device.engine.run('manual'); // the union needs a second pass
    for (const device of [a, b, c]) {
      await drain(device);
      expect(await device.repo.countNotes(), 'every browser holds the union').toBe(4);
    }
    expect((await a.repo.getNote(bNote))?.body).toBe('B typed this');
  });

  it('re-joining the same account after unlink re-pushes the log without doubling it', async () => {
    const server = auditServer();
    const account = await freshAccount('t');
    const a = browser(server, 'a');
    await a.engine.enrol(account.token, account.keyText);
    const note = await a.repo.createNote('note');
    await a.repo.saveBody(note, 'one');
    await a.repo.saveBody(note, 'two');
    await a.repo.importNotes([imported('## imported\n\nbody')]);
    await drain(a);
    const before = server.logOf(account.token).stored.length;
    expect(before).toBe(5);

    // Unlink rewinds the whole log, so everything is pushed again — the server dedupes on the op id.
    await a.engine.unlink();
    expect((await a.repo.unpushed()).length).toBe(5);
    await a.engine.enrol(account.token, account.keyText);
    await drain(a);

    expect(server.logOf(account.token).stored.length).toBe(before);
    expect(await a.repo.versions(note)).toHaveLength(2);
    const fresh = browser(server, 'b');
    await fresh.engine.enrol(account.token, account.keyText);
    expect(await fresh.repo.countNotes()).toBe(2);
    expect(await fresh.repo.versions(note)).toHaveLength(2);
  });

  it('a browser that only has the token gets the history, item texts and dates back', async () => {
    const server = auditServer();
    const account = await freshAccount('t');
    const a = browser(server, 'a');
    await a.engine.enrol(account.token, account.keyText);
    const note = await a.repo.createNote('note');
    await a.repo.saveBody(note, 'v1');
    await a.repo.saveBody(note, 'v2');
    await a.repo.saveBody(note, 'v3');
    const list = await a.repo.createNote('todo');
    await a.repo.addItem(list, 'milk');
    await a.repo.addItem(list, 'call mum');
    await a.repo.importNotes([imported('## old entry\n\nfrom 2017', Date.parse('2017-01-01T00:00:00Z'))]);
    await drain(a);

    // Storage was evicted: the token is all that survived, the key came from the user's copy.
    const b = browser(server, 'b');
    await b.engine.enrol(account.token, account.keyText);
    expect((await b.repo.getNote(note))?.body).toBe('v3');
    expect(await b.repo.versions(note)).toHaveLength(3);
    expect((await b.repo.items(list)).map((item) => item.text)).toEqual(['milk', 'call mum']);
    expect(await b.repo.syncCursor(await accountTag(account.token))).toBe(server.logOf(account.token).stored.length);
  });

  it('re-pull the log while imports are pending pushes them and duplicates nothing', async () => {
    const server = auditServer();
    const account = await freshAccount('t');
    const a = browser(server, 'a');
    await a.engine.enrol(account.token, account.keyText);
    const note = await a.repo.createNote('note');
    await a.repo.saveBody(note, 'on the account');
    await drain(a);

    // Imports pending, and the user hits "re-pull the log" before they went up.
    await a.repo.importNotes([imported('## pending\n\nnot pushed yet')]);
    await a.engine.repair();
    await drain(a);

    expect(await a.repo.countNotes()).toBe(2);
    expect(await a.repo.versions(note)).toHaveLength(1);
    const fresh = browser(server, 'b');
    await fresh.engine.enrol(account.token, account.keyText);
    expect(await fresh.repo.countNotes()).toBe(2);
  });

  it('a second tab that never saw the signup picks the new account up and syncs its imports', async () => {
    const server = auditServer();
    const repo = testRepo('shared');
    const store = memoryStore();
    const tab1 = createEngine({ repo, store, transport: server.transport });
    const tab2 = createEngine({ repo, store, transport: server.transport });

    // Local work before there is any account, including an import.
    await repo.importNotes([imported('## written before any account\n\nlocal')]);
    const created = await signupAs(tab1, 't-y');

    // The second tab opens afterwards: it reads the keystore, syncs the shared database and pushes
    // what the first tab left to it.
    void tab2.start();
    await waitFor(() => tab2.enrolled(), 'the second tab to load the account');
    await waitFor(async () => (await repo.unpushed()).length === 0, 'the outbox to drain');
    expect(tab2.token()).toBe(created.token);

    const fresh = browser(server, 'b');
    await fresh.engine.enrol(created.token, created.key);
    expect(await fresh.repo.countNotes()).toBe(1);
    expect((await fresh.repo.listNotes())[0].title).toBe('written before any account');
  });
});
