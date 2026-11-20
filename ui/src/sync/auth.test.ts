// @vitest-environment node
// The blast radius of a leaked token, pinned. The design promise (design/003) is that a token
// holder can read envelope metadata and waste the account's cap and pull budget — and nothing
// else: no forged op may corrupt data, and a wasted cap may never split a device off. These
// tests assert the "nothing else" part from the client's side, with the thief pushing through
// the same transport any attacker with the token would use.
import { describe, expect, it } from 'vitest';
import { testRepo } from '../db/inProcess';
import { seal } from './crypto';
import { syncNow, type WireOp } from './client';
import { auditServer, freshAccount } from './testing';

describe('auth', () => {
  it('a forged op from a token thief is skipped unread, and costs the account nothing but space', async () => {
    const server = auditServer();
    const victim = await freshAccount('t');
    const repoA = testRepo('a');
    const id = await repoA.createNote('note');
    await repoA.saveBody(id, 'the real content');
    await syncNow({ repo: repoA, key: victim.key, token: victim.token, transport: server.transport });

    // The thief holds the token but not the key: they can push well-formed envelopes whose
    // ciphertext is sealed under a key of their own. GCM is what stops them from forging ours.
    const thiefKey = (await freshAccount('thief')).key;
    const garbage: WireOp[] = [];
    for (let i = 0; i < 2; i += 1) {
      garbage.push({
        id: `evil-${i}`,
        device: 'mallory',
        kind: i === 0 ? 'note_meta' : 'note_snapshot',
        note_id: 'a-note-the-thief-never-saw',
        created: 1_700_000_000_000,
        ciphertext: await seal(thiefKey, { anything: 'sealed under the thief key' }),
      });
    }
    await server.transport(victim.token, { device: 'mallory', cursor: 0, ops: garbage });

    // A device of the account skips both unread, keeps applying the real ops, and stays healthy.
    const repoB = testRepo('b');
    const first = await syncNow({ repo: repoB, key: victim.key, token: victim.token, transport: server.transport });
    expect(first.skipped).toBe(2);
    expect((await repoB.getNote(id))?.body).toBe('the real content');
    expect(await repoB.getNote('a-note-the-thief-never-saw')).toBeUndefined();
    const again = await syncNow({ repo: repoB, key: victim.key, token: victim.token, transport: server.transport });
    expect(again.pulled).toBe(0);
    expect((await repoB.getNote(id))?.body).toBe('the real content');
  });

  it('a thief can waste the cap: pushes stall but stay local, and pulls never stop', async () => {
    const server = auditServer();
    const victim = await freshAccount('t');
    const repoA = testRepo('a');
    const id = await repoA.createNote('note');
    await repoA.saveBody(id, 'rescuable content');
    await syncNow({ repo: repoA, key: victim.key, token: victim.token, transport: server.transport });

    // The thief fills the account with garbage under their own key, until nothing more fits.
    const thiefKey = (await freshAccount('thief')).key;
    const fill = async (count: number) => {
      const ops: WireOp[] = [];
      for (let i = 0; i < count; i += 1) {
        ops.push({
          id: `evil-${Math.random()}`,
          device: 'mallory',
          kind: 'note_meta',
          note_id: `fake-${i}`,
          created: 1_700_000_000_000,
          ciphertext: await seal(thiefKey, { filler: true }),
        });
      }
      return server.transport(victim.token, { device: 'mallory', cursor: 0, ops });
    };
    const filled = await fill(10);
    expect(filled.accepted).toBe(10);
    server.cfg.cap = server.usageOf(server.logOf(victim.token)); // now full, by the thief's doing

    // The victim keeps writing: the pushes stall (accepted 0) but nothing is lost, and the
    // account stays fully readable — a fresh device rescues everything.
    const id2 = await repoA.createNote('note');
    await repoA.saveBody(id2, 'still only local while the cap is full');
    const stalled = await syncNow({ repo: repoA, key: victim.key, token: victim.token, transport: server.transport });
    expect(stalled.pushed).toBe(0);
    expect((await repoA.unpushed()).length).toBe(2);
    expect((await repoA.getNote(id2))?.body).toBe('still only local while the cap is full');

    const repoC = testRepo('c');
    const rescue = await syncNow({ repo: repoC, key: victim.key, token: victim.token, transport: server.transport });
    expect(rescue.skipped).toBe(10); // the thief's garbage, unread and inert
    expect((await repoC.getNote(id))?.body).toBe('rescuable content');
    expect(await repoC.getNote(id2)).toBeUndefined(); // never left the writing device, never lost
  });
});
