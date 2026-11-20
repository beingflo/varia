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
  /** How many of the request's ops (in order) the account now holds: a full account accepts a
   *  prefix, and the rest must stay pending instead of being marked pushed. */
  accepted?: number;
  more: boolean;
  usage_bytes: number;
  cap_bytes: number;
};

export type Transport = (token: string, request: { device: string; cursor: number; ops: WireOp[] }) => Promise<SyncResponse>;

export type SyncState = {
  pushed: number;
  pulled: number;
  skipped: number;
  /** Ops over the wire limit: they never travel and stay pending, but must not block the rest. */
  oversized: number;
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
/** The server's per-op limit: an op above it is rejected with the whole request. */
const MAX_OP_BYTES = 4 * 1024 * 1024;
/** Batch budget, well under the server's request-size cap. */
const MAX_BATCH_BYTES = 12 * 1024 * 1024;

export async function syncNow(options: { repo: Repo; key: CryptoKey; token: string; transport: Transport }): Promise<SyncState> {
  const { repo, key, token, transport } = options;
  const account = await accountTag(token);
  const state: SyncState = {
    pushed: 0,
    pulled: 0,
    skipped: 0,
    oversized: 0,
    cursor: await repo.syncCursor(account),
    usage: 0,
    cap: 0,
    more: false,
    rewound: false,
  };
  const tooLarge = new Set<string>();

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const outbox = await repo.unpushed();
    const sealed = await Promise.all(
      outbox.map(async (op) => ({
        op,
        wire: {
          id: op.id,
          device: op.device,
          kind: op.kind,
          note_id: op.note_id,
          created: op.created,
          ciphertext: await seal(key, op),
        } satisfies WireOp,
      })),
    );
    const sendable: typeof sealed = [];
    let bytes = 0;
    for (const entry of sealed) {
      const size = Math.floor((entry.wire.ciphertext.length * 3) / 4);
      // An op the server would reject must not pin the rest of the outbox behind it. It stays
      // pending and is counted, never dropped: the data exists only here and locally.
      if (size > MAX_OP_BYTES) {
        tooLarge.add(entry.op.id);
        continue;
      }
      if (bytes + size > MAX_BATCH_BYTES && sendable.length > 0) break; // the next round takes the rest
      sendable.push(entry);
      bytes += size;
    }
    const ops = sendable.map((entry) => entry.wire);

    const response = await transport(token, { device: await repo.deviceId(), cursor: state.cursor, ops });

    // The server is behind us: a restored backup or a wiped account. Trust it, not the cursor, or
    // this device would sit on a log nobody else can see.
    if (response.head < state.cursor) {
      await repo.resetSync();
      state.cursor = 0;
      state.rewound = true;
      continue;
    }

    // Mark only what the server says it holds — a full account keeps the rest pending, and a
    // failed push leaves the outbox intact. Duplicates are ignored server-side, so a retry is
    // harmless either way.
    const accepted = Math.min(response.accepted ?? ops.length, ops.length);
    if (accepted > 0) {
      await repo.markPushed(sendable.slice(0, accepted).map(({ op }) => ({ id: op.id })));
      state.pushed += accepted;
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

  state.oversized = tooLarge.size;
  return state;
}
