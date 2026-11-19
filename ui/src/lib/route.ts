// Fifteen lines instead of a router dependency: one path signal, real history entries.
import { createSignal } from 'solid-js';

const current = () => `${location.pathname}${location.search}`;
const [path, setPath] = createSignal(current());

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => setPath(current()));
}

export function usePath() {
  return path;
}

export function navigate(to: string): void {
  if (to === current()) return;
  history.pushState(null, '', to);
  setPath(current());
}

/** `/note/<id>` and `/todo/<id>` are the only routes; anything else is the list. */
export function parsePath(pathname: string): { view: 'list' } | { view: 'note' | 'todo'; id: string } {
  const match = /^\/(note|todo)\/([^/]+)$/.exec(pathname);
  return match ? { view: match[1] as 'note' | 'todo', id: match[2] } : { view: 'list' };
}
