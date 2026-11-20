import { describe, expect, it, vi } from 'vitest';
import { createClient } from './client';

/** A worker that answers immediately, and a channel that never echoes back to the sender. */
function fakes() {
  const worker = {
    sent: [] as string[],
    postMessage: (message: { id: number; method: string }) => {
      worker.sent.push(message.method);
      setTimeout(() => worker.onmessage?.({ data: { id: message.id, result: 'ok' } } as MessageEvent), 0);
    },
    onerror: null,
    onmessage: null as ((event: MessageEvent) => void) | null,
  };
  const channel = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
  return { worker, channel };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

const fakeOps = (count: number) =>
  Array.from({ length: count }, (_, seq) => ({
    id: `op-${seq}`,
    device: 'device-x',
    kind: 'note_snapshot' as const,
    note_id: 'note-1',
    lamport: seq + 1,
    created: 1_700_000_000 + seq,
    payload: {},
  }));

describe('worker client', () => {
  it('notifies this tab on a write, without waiting for its own broadcast', async () => {
    const { worker, channel } = fakes();
    const repo = createClient(worker as unknown as Worker, channel as unknown as BroadcastChannel);
    const seen = vi.fn();
    repo.onChange(seen);

    await repo.createNote('note');
    await settle();
    expect(seen).toHaveBeenCalledTimes(1); // the sender is never echoed by BroadcastChannel
    expect(channel.postMessage).toHaveBeenCalledWith('createNote');
  });

  // The trap: a page of pulled ops applied one by one was one worker call, one commit and one view
  // refresh per op. A page must be one call and one notification.
  it('applies a pulled page in a single worker call and a single notification', async () => {
    const { worker, channel } = fakes();
    const repo = createClient(worker as unknown as Worker, channel as unknown as BroadcastChannel);
    const seen = vi.fn();
    repo.onChange(seen);

    await repo.applyRemote(fakeOps(200));
    await settle();

    expect(worker.sent.filter((method) => method === 'applyRemote')).toHaveLength(1);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(channel.postMessage).toHaveBeenCalledTimes(1); // other tabs refresh once, not 200 times
  });

  it('treats sync bookkeeping as no change at all', async () => {
    const { worker, channel } = fakes();
    const repo = createClient(worker as unknown as Worker, channel as unknown as BroadcastChannel);
    const seen = vi.fn();
    repo.onChange(seen);

    await repo.markPushed([{ id: 'op-1' }]);
    await repo.applyRemotePage([], 7, 'tag');
    await settle();

    // Otherwise every sync would schedule the next one.
    expect(seen).not.toHaveBeenCalled();
    expect(channel.postMessage).not.toHaveBeenCalled();
  });

  it('notifies on writes from other tabs, and never on reads', async () => {
    const { worker, channel } = fakes();
    const repo = createClient(worker as unknown as Worker, channel as unknown as BroadcastChannel);
    const seen = vi.fn();
    repo.onChange(seen);

    await repo.listNotes();
    await settle();
    expect(seen).not.toHaveBeenCalled();
    expect(channel.postMessage).not.toHaveBeenCalled();

    channel.onmessage?.({} as MessageEvent);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
