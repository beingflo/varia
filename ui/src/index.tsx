import { render } from 'solid-js/web';
import App from './App';
import { createClient } from './db/client';
import { RepoProvider } from './db/context';
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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // last-chance save for the open note is handled by its blur; sync arrives in phase 2
  }
});
