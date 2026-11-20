// @vitest-environment node
// Two devices, one note: whatever A has, B ends up
// with, including the parent links the graph is drawn from.
import { describe, expect, it } from 'vitest';
import { testRepo } from '../db/inProcess';
import { accountTag, newRootKey, opKey } from './crypto';
import { syncNow, type SyncResponse, type Transport, type WireOp } from './client';

function fakeServer(page = 2) {
  const stored: (WireOp & { server_seq: number })[] = [];
  const seen = new Set<string>();
  const transport: Transport = async (_token, { cursor, ops }) => {
    const base = stored.length;
    let written = 0;
    for (const op of ops) {
      if (seen.has(op.id)) continue;
      seen.add(op.id);
      stored.push({ ...op, server_seq: stored.length + 1 });
      written = stored.length;
    }
    const floor = cursor >= base ? Math.max(cursor, written) : cursor;
    const pageOps = stored.filter((op) => op.server_seq > floor).slice(0, page);
    const response: SyncResponse = {
      ops: pageOps,
      head: stored.length,
      cursor: pageOps.length > 0 ? pageOps[pageOps.length - 1].server_seq : floor,
      more: stored.some((op) => op.server_seq > (pageOps.at(-1)?.server_seq ?? floor)),
      usage_bytes: 0,
      cap_bytes: 0,
    };
    return response;
  };
  return { transport, stored };
}

async function pair() {
  const key = await opKey(newRootKey());
  return { key, a: testRepo('device-a'), b: testRepo('device-b') };
}

const shape = async (repo: ReturnType<typeof testRepo>, id: string) =>
  (await repo.versions(id)).map((v) => `${v.id}|${v.parent_id}`).sort();

describe('convergence', () => {
  it('a branch made offline reaches the other device with its parent', async () => {
    const { key, a, b } = await pair();
    const server = fakeServer();
    const id = await a.createNote('note');
    await a.saveBody(id, 'line 1');
    await a.saveBody(id, 'line 2');
    await a.saveBody(id, 'line 3');
    await syncNow({ repo: a, key, token: 't', transport: server.transport });
    for (let round = 0; round < 5; round += 1) {
      if (!(await syncNow({ repo: b, key, token: 't', transport: server.transport })).more) break;
    }

    // Both devices write from the same head while offline: a fork, no merge.
    await a.saveBody(id, 'from a');
    await b.saveBody(id, 'from b');
    // A third version on A, written while B's branch is open.
    await a.saveBody(id, 'from a again');

    const sent = await syncNow({ repo: a, key, token: 't', transport: server.transport });
    expect(sent.skipped).toBe(0);
    expect(await a.unpushed()).toHaveLength(0);

    for (let round = 0; round < 10; round += 1) {
      const state = await syncNow({ repo: b, key, token: 't', transport: server.transport });
      if (!state.more) break;
    }
    // A has to come back for B's branch: nothing pushes it.
    for (let round = 0; round < 10; round += 1) {
      if (!(await syncNow({ repo: a, key, token: 't', transport: server.transport })).more) break;
    }

    expect(await shape(b, id)).toEqual(await shape(a, id));
    expect(await b.versions(id)).toHaveLength((await a.versions(id)).length);
  });

  it('a device that pushes nothing still gets every op of a large backlog', async () => {
    const { key, a, b } = await pair();
    const server = fakeServer(3);
    const id = await a.createNote('note');
    for (let n = 1; n <= 12; n += 1) await a.saveBody(id, `line ${n}`);
    await syncNow({ repo: a, key, token: 't', transport: server.transport });

    for (let round = 0; round < 20; round += 1) {
      const state = await syncNow({ repo: b, key, token: 't', transport: server.transport });
      if (!state.more) break;
    }
    expect(await shape(b, id)).toEqual(await shape(a, id));
  });

  it('re-pulling the log fills a version a stale cursor skipped', async () => {
    const { key, a, b } = await pair();
    const server = fakeServer(1); // one op per page, so a cursor can be moved past an unread op
    const id = await a.createNote('note');
    await a.saveBody(id, 'line 1');
    await syncNow({ repo: a, key, token: 't', transport: server.transport });

    // What the floor bug did: the cursor ends up past ops this device never received.
    const account = await accountTag('t');
    await b.applyRemotePage([], 2, account);
    expect((await syncNow({ repo: b, key, token: 't', transport: server.transport })).pulled).toBe(0);
    expect(await b.versions(id)).toHaveLength(0);

    await b.resetCursor(account); // "re-pull the log" in the sync panel
    for (let round = 0; round < 10; round += 1) {
      if (!(await syncNow({ repo: b, key, token: 't', transport: server.transport })).more) break;
    }
    expect(await b.versions(id)).toHaveLength(1);
    expect(await shape(b, id)).toEqual(await shape(a, id));
  });

  it('an empty database with the token and key pulls the whole log again', async () => {
    const { key, a } = await pair();
    const server = fakeServer();
    const id = await a.createNote('note');
    await a.saveBody(id, 'line 1');
    await a.saveBody(id, 'line 2');
    while ((await syncNow({ repo: a, key, token: 't', transport: server.transport })).more);

    // What an evicted install leaves: the account, no database. Its cursor is 0, so the log replays.
    const evicted = testRepo('device-a');
    expect(await evicted.syncCursor(await accountTag('t'))).toBe(0);
    while ((await syncNow({ repo: evicted, key, token: 't', transport: server.transport })).more);

    expect(await shape(evicted, id)).toEqual(await shape(a, id));
    expect((await evicted.getNote(id))?.body).toBe('line 2');
  });

  it('both devices write, then both sync: each keeps the other branch', async () => {
    const { key, a, b } = await pair();
    const server = fakeServer();
    const id = await a.createNote('note');
    await a.saveBody(id, 'base');
    await syncNow({ repo: a, key, token: 't', transport: server.transport });
    for (let round = 0; round < 5; round += 1) {
      if (!(await syncNow({ repo: b, key, token: 't', transport: server.transport })).more) break;
    }

    // Both edit the same version while offline.
    await a.saveBody(id, 'from a');
    await b.saveBody(id, 'from b');
    await syncNow({ repo: a, key, token: 't', transport: server.transport });
    for (let round = 0; round < 5; round += 1) {
      if (!(await syncNow({ repo: b, key, token: 't', transport: server.transport })).more) break;
    }
    await syncNow({ repo: a, key, token: 't', transport: server.transport });

    expect(await shape(b, id)).toEqual(await shape(a, id));
    expect(await a.heads(id)).toHaveLength(2);
    expect(await b.heads(id)).toHaveLength(2);
  });
});
