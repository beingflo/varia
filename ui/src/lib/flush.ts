// Views with unsaved state register a flush; it runs on save, on leaving the view and when
// the tab is hidden. Never rejects: one broken view must not block the others.
const flushers = new Set<() => unknown>();

export function registerFlush(fn: () => unknown): () => void {
  flushers.add(fn);
  return () => flushers.delete(fn);
}

export async function flushAll(): Promise<void> {
  for (const flush of flushers) {
    try {
      await flush();
    } catch (err) {
      console.error('flush failed', err);
    }
  }
}
