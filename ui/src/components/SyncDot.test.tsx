import { render } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import type { Engine, SyncStatus } from '../sync/engine';
import { SyncProvider } from '../sync/context';
import SyncDot from './SyncDot';

const fake = (status: Partial<SyncStatus>, enrolled = true) =>
  ({
    status: () => ({ state: 'off', pending: 0, last: 0, usage: 0, cap: 0, error: '', ...status }),
    enrolled: () => enrolled,
  }) as unknown as Engine;

const dot = (engine: Engine) => {
  const { container } = render(() => (
    <SyncProvider engine={engine}>
      <SyncDot />
    </SyncProvider>
  ));
  return container.querySelector('.sync-dot');
};

describe('sync dot', () => {
  it('is green after a good sync and says when', () => {
    const el = dot(fake({ state: 'idle', last: Date.now() - 60_000 }))!;
    expect(el.classList.contains('ok')).toBe(true);
    expect(el.getAttribute('aria-label')).toBe('synced 1m');
  });

  it('pulses while a sync runs', () => {
    const el = dot(fake({ state: 'syncing' }))!;
    expect(el.classList.contains('syncing')).toBe(true);
  });

  it('goes hollow when the last attempt failed, and names the reason', () => {
    const el = dot(fake({ state: 'error', error: 'offline' }))!;
    expect(el.classList.contains('failed')).toBe(true);
    expect(el.getAttribute('aria-label')).toBe('sync failed: offline');
  });

  it('is absent when sync is off', () => {
    expect(dot(fake({}, false))).toBeNull();
  });
});
