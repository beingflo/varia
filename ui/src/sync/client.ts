// One sync call: push the outbox, pull what is missing, apply it. Transport and key come from
// outside, so this is testable without a network or a browser.
import type { Repo } from '../db/api';
import { accountTag } from './crypto';
import type { Op } from '../db/types';
import { openSealed, seal } from './crypto';

export type WireOp = {
  /** Random op id: the server's dedupe key, so a retried push is harmless. */
  id: string;
  device: string;
  kind: string;
  note_id: string;
  created: number;
  /** JSON → gzip → AES-GCM, base64: the server orders and stores this but cannot read it. */
  ciphertext: string;
};

export type SyncResponse = {
  ops: (WireOp & { server_seq: number })[];
  cursor: number;
  /** The account's highest `server_seq`; below our cursor means the server lost ops. */
  head: number;
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
  /** The account has more ops than one call may pull: ask again right away. */
  more: boolean;
  /** The server's log had lost ops this device had: everything was re-pushed from scratch. */
  rewound: boolean;
};

/** Round-trip limit per call: `more` comes back when the account has more ops than one page. */
const MAX_ROUNDS = 5;

export async function syncNow(options: { repo: Repo; key: CryptoKey; token: string; transport: Transport }): Promise<SyncState> {
  const { repo, key, token, transport } = options;
  const account = await accountTag(token);
  const state: SyncState = {
    pushed: 0,
    pulled: 0,
    skipped: 0,
    cursor: await repo.syncCursor(account),
    usage: 0,
    cap: 0,
    more: false,
    rewound: false,
  };

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const outbox = await repo.unpushed();
    const ops: WireOp[] = await Promise.all(
      outbox.map(async (op) => ({
        id: op.id,
        device: op.device,
        kind: op.kind,
        note_id: op.note_id,
        created: op.created,
        ciphertext: await seal(key, op),
      })),
    );

    const response = await transport(token, { device: await repo.deviceId(), cursor: state.cursor, ops });

    // The server is behind us: a restored backup or a wiped account. Trust it, not the cursor, or
    // this device would sit on a log nobody else can see.
    if (response.head < state.cursor) {
      await repo.resetSync();
      state.cursor = 0;
      state.rewound = true;
      continue;
    }

    // Only after the server accepted them: a failed push must leave the outbox intact. Duplicates
    // are ignored server-side, so a second attempt is harmless.
    if (ops.length > 0) {
      await repo.markPushed(outbox.map(({ id }) => ({ id })));
      state.pushed += ops.length;
    }

    // Decrypt in parallel and store the whole page in one worker call: one transaction and one
    // view refresh per page instead of per op.
    const opened = await Promise.allSettled(response.ops.map((wire) => openSealed(key, wire.ciphertext)));
    const page: Op[] = [];
    for (const result of opened) {
      if (result.status === 'fulfilled') page.push(result.value as Op);
      // A wrong key or a damaged op would block the cursor forever; skip it and move on.
      else state.skipped += 1;
    }
    // One worker call: the page and the cursor it stands for land in the same transaction.
    state.pulled += await repo.applyRemotePage(page, response.cursor, account);
    state.cursor = Math.max(state.cursor, response.cursor);
    state.usage = response.usage_bytes;
    state.cap = response.cap_bytes;
    state.more = response.more;
    if (!response.more) break;
  }

  return state;
}
