// Views with unsaved state register a flush; it runs on save, on leaving the view and when
// the tab is hidden. Never rejects: one broken view must not block the others.
//
// `background` marks the flush a sync does before pushing. A view must not turn what is being
// typed into something permanent for it: a half-typed item would become an item of its own while
// the caret keeps going in the field.
const flushers = new Set<(background: boolean) => unknown>();

export function registerFlush(fn: (background: boolean) => unknown): () => void {
  flushers.add(fn);
  return () => flushers.delete(fn);
}

export async function flushAll(background = false): Promise<void> {
  for (const flush of flushers) {
    try {
      await flush(background);
    } catch (err) {
      console.error('flush failed', err);
    }
  }
}
