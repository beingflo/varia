// @vitest-environment node
// The service is faked with the same semantics that matter: dedupe, server order, a cursor, and no
// echo of what a request just pushed.
import { describe, expect, it } from 'vitest';
import type { Repo } from '../db/api';
import type { Op } from '../db/types';
import { testRepo } from '../db/inProcess';
import { newRootKey, opKey, seal } from './crypto';
import { syncNow, type SyncResponse, type Transport, type WireOp } from './client';

function fakeServer() {
  const stored: (WireOp & { server_seq: number })[] = [];
  const seen = new Set<string>();
  const transport: Transport = async (_token, { cursor, ops }) => {
    let written = 0;
    for (const op of ops) {
      const key = `${op.device}:${op.seq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stored.push({ ...op, server_seq: stored.length + 1 });
      written = stored.length;
    }
    const floor = Math.max(cursor, written);
    const page = stored.filter((op) => op.server_seq > floor).slice(0, 2);
    const response: SyncResponse = {
      ops: page,
      cursor: page.length > 0 ? page[page.length - 1].server_seq : floor,
      more: stored.filter((op) => op.server_seq > (page.at(-1)?.server_seq ?? floor)).length > 0,
      usage_bytes: stored.length,
      cap_bytes: 500,
    };
    return response;
  };
  return { transport, stored };
}

async function pair() {
  const key = await opKey(newRootKey());
  return { key, sender: testRepo('device-a'), receiver: testRepo('device-b') };
}

/** Records each `applyRemote` call, to pin the batching: one call per pulled page, never per op. */
function spied(repo: Repo) {
  const batches: Op[][] = [];
  const applyRemote = repo.applyRemote.bind(repo);
  repo.applyRemote = async (ops) => {
    batches.push(ops);
    return applyRemote(ops);
  };
  return { repo, batches };
}

async function writeNote(repo: Repo, body: string) {
  const id = await repo.createNote('note');
  await repo.saveBody(id, body);
  return id;
}

describe('sync', () => {
  it('pushes the outbox and a second device materialises the same note', async () => {
    const { key, sender, receiver } = await pair();
    const server = fakeServer();
    const id = await writeNote(sender, '# Lab notes\nthe retry loop coalesces');
    expect(await sender.unpushed()).toHaveLength(2);

    const sent = await syncNow({ repo: sender, key, token: 't', transport: server.transport });
    expect(sent.pushed).toBe(2);
    expect(await sender.unpushed()).toHaveLength(0);

    const received = await syncNow({ repo: receiver, key, token: 't', transport: server.transport });
    expect(received.pulled).toBe(2);
    expect(received.skipped).toBe(0);

    const [note] = await receiver.listNotes();
    expect(note.id).toBe(id);
    expect(note.title).toBe('Lab notes');
    expect(await receiver.getNote(id)).toMatchObject({ body: '# Lab notes\nthe retry loop coalesces' });
  });

  it('leaves the outbox untouched when the push fails', async () => {
    const { key, sender } = await pair();
    await writeNote(sender, 'body');
    const transport: Transport = async () => {
      throw new Error('offline');
    };

    await expect(syncNow({ repo: sender, key, token: 't', transport })).rejects.toThrow('offline');
    expect(await sender.unpushed()).toHaveLength(2);
  });

  it('pages through a backlog and moves the cursor past every op', async () => {
    const { key, sender, receiver } = await pair();
    const server = fakeServer();
    const id = await sender.createNote('note');
    await sender.saveBody(id, 'one');
    await sender.saveBody(id, 'two');
    await sender.saveBody(id, 'three');
    await syncNow({ repo: sender, key, token: 't', transport: server.transport });

    // One note_meta plus three snapshots, delivered two per round.
    const received = await syncNow({ repo: receiver, key, token: 't', transport: server.transport });
    expect(received.pulled).toBe(4);
    expect(received.cursor).toBe(4);
    expect(await receiver.syncCursor()).toBe(4);
    expect((await receiver.getNote(id))?.body).toBe('three');

    // Nothing left: a further sync is a no-op, not a loop.
    const again = await syncNow({ repo: receiver, key, token: 't', transport: server.transport });
    expect(again).toMatchObject({ pushed: 0, pulled: 0, cursor: 4 });
  });

  // The trap: applying op by op meant one worker round trip, one commit and one view refresh each,
  // which turned a 400-op replay into seconds of visible history churn.
  it('applies a pulled backlog in one batch per page, not one call per op', async () => {
    const { key, sender } = await pair();
    const server = fakeServer();
    const id = await sender.createNote('note');
    for (const body of ['one', 'two', 'three']) await sender.saveBody(id, body);
    await syncNow({ repo: sender, key, token: 't', transport: server.transport });

    const { repo: receiver, batches } = spied(testRepo('device-b'));
    await syncNow({ repo: receiver, key, token: 't', transport: server.transport });

    // The fake service serves two ops per page: one note_meta plus three snapshots is four ops,
    // two pages, so two calls.
    expect(batches.map((batch) => batch.length)).toEqual([2, 2]);
    expect((await receiver.getNote(id))?.body).toBe('three');
  });

  it('seals a whole outbox in one pass rather than op by op', async () => {
    const { key, sender, receiver } = await pair();
    const server = fakeServer();
    const id = await writeNote(sender, 'body');
    const sent = await syncNow({ repo: sender, key, token: 't', transport: server.transport });
    expect(sent.pushed).toBe(2); // note_meta plus one snapshot, both in the single request
    expect(server.stored).toHaveLength(2);

    const received = await syncNow({ repo: receiver, key, token: 't', transport: server.transport });
    expect(received.pulled).toBe(2);
    expect((await receiver.getNote(id))?.body).toBe('body');
  });

  it('skips an op it cannot decrypt and still advances the cursor', async () => {
    const { key, sender, receiver } = await pair();
    const server = fakeServer();
    const stranger = await opKey(newRootKey());
    server.stored.push({
      device: 'device-x',
      seq: 1,
      kind: 'note_meta',
      note_id: 'elsewhere',
      created: 1,
      ciphertext: await seal(stranger, { device: 'device-x', seq: 1, kind: 'note_meta', note_id: 'elsewhere', created: 1, lamport: 1, payload: {} }),
      server_seq: 1,
    });
    await writeNote(sender, 'readable whatever the key says');
    await syncNow({ repo: sender, key, token: 't', transport: server.transport });

    const received = await syncNow({ repo: receiver, key, token: 't', transport: server.transport });
    expect(received.skipped).toBe(1);
    expect(received.cursor).toBe(3);
  });

  it('takes the remote lamport so the next local write still wins', async () => {
    const { key, sender, receiver } = await pair();
    const server = fakeServer();
    const id = await writeNote(sender, 'from a');
    await syncNow({ repo: sender, key, token: 't', transport: server.transport });
    await syncNow({ repo: receiver, key, token: 't', transport: server.transport });

    const remote = await sender.unpushed(); // empty, but the sender's clock is at 2
    expect(remote).toHaveLength(0);
    await receiver.saveBody(id, 'from b');
    const [next] = await receiver.unpushed();
    expect(next.lamport).toBeGreaterThan(2);
  });
});
