import { describe, expect, it, vi } from 'vitest';
import { createClient } from './client';

/** A worker that answers immediately, and a channel that never echoes back to the sender. */
function fakes() {
  const worker = {
    postMessage: (message: { id: number }) =>
      setTimeout(() => worker.onmessage?.({ data: { id: message.id, result: 'ok' } } as MessageEvent), 0),
    onerror: null,
    onmessage: null as ((event: MessageEvent) => void) | null,
  };
  const channel = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
  return { worker, channel };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

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
