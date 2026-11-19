// Mounts the debug overlay in its own shadow root. Any failure stays inside this function.
import { ErrorBoundary } from 'solid-js';
import { render } from 'solid-js/web';
import type { Repo } from '../db/api';
import Debug from './Debug';
import { DEBUG_CSS } from './style';

let dispose: (() => void) | undefined;
let host: HTMLElement | undefined;

function close() {
  dispose?.();
  dispose = undefined;
  host?.remove();
  host = undefined;
}

export function toggleDebug(repo: Repo): void {
  if (dispose) {
    close();
    return;
  }
  try {
    host = document.createElement('div');
    host.dataset.variaDebug = '';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = DEBUG_CSS;
    root.appendChild(style);
    const container = document.createElement('div');
    root.appendChild(container);
    dispose = render(
      () => (
        <ErrorBoundary
          fallback={(err) => (
            <div class="panel">
              <header>
                <span class="name">varia · database</span>
                <button type="button" onClick={close}>
                  close
                </button>
              </header>
              <p class="error">debug overlay failed: {String((err as Error)?.message ?? err)}</p>
            </div>
          )}
        >
          <Debug repo={repo} onClose={close} />
        </ErrorBoundary>
      ),
      container,
    );
  } catch (err) {
    console.warn('debug overlay failed to mount', err);
    close();
  }
}
