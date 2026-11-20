import { Show } from 'solid-js';
import { ago } from '../lib/time';
import { useSync } from '../sync/context';

/**
 * Sync state in the bottom-right corner on every screen: a green dot after a good sync, a slow
 * pulse while one runs, a hollow grey dot when the last attempt failed (offline, server, cap).
 * Nothing when sync is off — there is no state to report.
 */
export default function SyncDot() {
  const sync = useSync();
  const state = () => sync.status().state;
  const label = () => {
    const status = sync.status();
    if (status.state === 'syncing') return 'syncing…';
    if (status.state === 'error') return `sync failed: ${status.error || 'offline'}`;
    return status.last ? `synced ${ago(status.last)}` : 'sync on';
  };

  return (
    <Show when={sync.enrolled()}>
      <span
        class="sync-dot"
        classList={{ ok: state() === 'idle', syncing: state() === 'syncing', failed: state() === 'error' }}
        role="status"
        aria-label={label()}
        title={label()}
      />
    </Show>
  );
}
