// One key map, one dispatcher. Views register what they can do; unclaimed commands do nothing.
export type Command = 'list' | 'new-note' | 'new-list' | 'delete' | 'save' | 'history' | 'toggle-done' | 'debug';

const handlers = new Map<Command, () => void>();

export function onCommand(command: Command, fn: () => void): () => void {
  handlers.set(command, fn);
  return () => {
    if (handlers.get(command) === fn) handlers.delete(command);
  };
}

/** Views listen for this to take the caret back after an overlay closes. */
export function focusEditor(): void {
  window.dispatchEvent(new Event('varia:focus'));
}

export function onEditorFocus(fn: () => void): () => void {
  window.addEventListener('varia:focus', fn);
  return () => window.removeEventListener('varia:focus', fn);
}

export function runCommand(command: Command): void {
  try {
    handlers.get(command)?.();
  } catch (err) {
    console.error(`command ${command} failed`, err);
  }
}

/**
 * Browsers own ⌘K/⌘N/⌘D/⌘L in a tab, so every command also answers to an ⌥⌘ form,
 * and standalone (installed PWA) windows get the plain one.
 */
export function commandFor(event: KeyboardEvent): Command | undefined {
  // Either modifier: the platform is not sniffable (and browsers differ). The list overlay
  // captures Ctrl+J/K itself, so plain Ctrl+K never reaches this.
  if (!(event.metaKey || event.ctrlKey)) return undefined;
  const key = event.key.toLowerCase();
  if (event.shiftKey) {
    return { e: 'new-list', h: 'history', a: 'toggle-done', d: 'debug' }[key] as Command | undefined;
  }
  if (event.altKey) {
    return { k: 'list', e: 'new-note', d: 'delete', s: 'save', a: 'toggle-done', h: 'history' }[key] as
      | Command
      | undefined;
  }
  return { k: 'list', e: 'new-note', d: 'delete', s: 'save' }[key] as Command | undefined;
}
