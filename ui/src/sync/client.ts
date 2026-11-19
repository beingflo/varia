// One sync call: push the outbox, pull what is missing, apply it. Transport and key come from
// outside, so this is testable without a network or a browser.
import type { Repo } from '../db/api';
import type { Op } from '../db/types';
import { openSealed, seal } from './crypto';

export type WireOp = {
  device: string;
  seq: number;
  kind: string;
  note_id: string;
  created: number;
  /** JSON → gzip → AES-GCM, base64: the server orders and stores this but cannot read it. */
  ciphertext: string;
};

export type SyncResponse = {
  ops: (WireOp & { server_seq: number })[];
  cursor: number;
  more: boolean;
  usage_bytes: number;
  cap_bytes: number;
};

export type Transport = (token: string, request: { device: string; cursor: number; ops: WireOp[] }) => Promise<SyncResponse>;

export type SyncState = {
  pushed: number;
  pulled: number;
  skipped: number;
  cursor: number;
  usage: number;
  cap: number;
};

/** Round-trip limit per call: `more` comes back when the account has more ops than one page. */
const MAX_ROUNDS = 5;

export async function syncNow(options: { repo: Repo; key: CryptoKey; token: string; transport: Transport }): Promise<SyncState> {
  const { repo, key, token, transport } = options;
  const state: SyncState = { pushed: 0, pulled: 0, skipped: 0, cursor: await repo.syncCursor(), usage: 0, cap: 0 };

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const outbox = await repo.unpushed();
    const ops: WireOp[] = [];
    for (const op of outbox) {
      ops.push({
        device: op.device,
        seq: op.seq,
        kind: op.kind,
        note_id: op.note_id,
        created: op.created,
        ciphertext: await seal(key, op),
      });
    }

    const response = await transport(token, { device: await repo.deviceId(), cursor: state.cursor, ops });

    // Only after the server accepted them: a failed push must leave the outbox intact. Duplicates
    // are ignored server-side, so a second attempt is harmless.
    if (ops.length > 0) {
      await repo.markPushed(outbox.map(({ device, seq }) => ({ device, seq })));
      state.pushed += ops.length;
    }

    for (const wire of response.ops) {
      try {
        await repo.applyRemote((await openSealed(key, wire.ciphertext)) as Op);
        state.pulled += 1;
      } catch {
        // A wrong key or a damaged op would block the cursor forever; skip it and move on.
        state.skipped += 1;
      }
    }

    state.cursor = Math.max(state.cursor, response.cursor);
    await repo.setSyncCursor(state.cursor);
    state.usage = response.usage_bytes;
    state.cap = response.cap_bytes;
    if (!response.more) break;
  }

  return state;
}
