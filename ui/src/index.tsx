import { render } from 'solid-js/web';
import App from './App';
import { createClient } from './db/client';
import { RepoProvider } from './db/context';
import { commandFor, runCommand } from './lib/commands';
import { flushAll } from './lib/flush';
import './style.css';

const worker = new Worker(new URL('./db/worker.ts', import.meta.url), { type: 'module' });
const repo = createClient(worker);

// Best effort only: this does not protect against WebKit's 7-day deletion rule (design/001 D6).
void navigator.storage?.persist?.();

// One global readiness marker, so tests and loading states do not have to guess per view.
void repo.deviceId().then(() => {
  document.documentElement.dataset.db = 'ready';
});

render(
  () => (
    <RepoProvider repo={repo}>
      <App />
    </RepoProvider>
  ),
  document.getElementById('root')!,
);

function openDebug() {
  // Its own chunk, mounted behind an ErrorBoundary: a failure here cannot reach the app.
  void import('./debug/mount')
    .then((m) => m.toggleDebug(repo))
    .catch((err) => console.warn('debug overlay unavailable', err));
}

window.addEventListener('keydown', (event) => {
  const command = commandFor(event);
  if (!command) return;
  event.preventDefault();
  if (command === 'debug') openDebug();
  else runCommand(command);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flushAll();
});

if (new URLSearchParams(location.search).has('debug')) openDebug();
