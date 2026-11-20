// One key map, one dispatcher. Views register what they can do; unclaimed commands do nothing.
export type Command =
  | 'list'
  | 'new-note'
  | 'new-list'
  | 'delete'
  | 'save'
  | 'history'
  | 'toggle-done'
  | 'sync'
  | 'debug';

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
type Mod = 'mod' | 'alt' | 'shift';
type Chord = { key: string; mods: Mod[] };

/** The one shortcut table: `commandFor` looks commands up here, the landing page lists them. */
export const BINDINGS: { command: Command; label: string; chords: Chord[] }[] = [
  {
    command: 'list',
    label: 'find or switch note',
    chords: [
      { key: 'k', mods: ['mod'] },
      { key: 'k', mods: ['mod', 'alt'] },
    ],
  },
  {
    command: 'new-note',
    label: 'new note',
    chords: [
      { key: 'e', mods: ['mod'] },
      { key: 'e', mods: ['mod', 'alt'] },
    ],
  },
  { command: 'new-list', label: 'new list', chords: [{ key: 'e', mods: ['mod', 'shift'] }] },
  {
    command: 'save',
    label: 'save now',
    chords: [
      { key: 's', mods: ['mod'] },
      { key: 's', mods: ['mod', 'alt'] },
    ],
  },
  {
    command: 'delete',
    label: 'delete note or item',
    chords: [
      { key: 'd', mods: ['mod'] },
      { key: 'd', mods: ['mod', 'alt'] },
    ],
  },
  {
    command: 'toggle-done',
    label: 'check or uncheck item',
    chords: [
      { key: 'a', mods: ['mod', 'alt'] },
      { key: 'a', mods: ['mod', 'shift'] },
    ],
  },
  {
    command: 'history',
    label: 'versions',
    chords: [
      { key: 'h', mods: ['mod', 'alt'] },
      { key: 'h', mods: ['mod', 'shift'] },
    ],
  },
  { command: 'sync', label: 'sync', chords: [{ key: 's', mods: ['mod', 'shift'] }] },
  { command: 'debug', label: 'debug overlay', chords: [{ key: 'd', mods: ['mod', 'shift'] }] },
];

const SYMBOL: Record<Mod, string> = { mod: '⌘', alt: '⌥', shift: '⇧' };

/** `⌘K`, `⌥⌘K`: the keycap text the landing page shows. */
export const chordLabel = (chord: Chord): string =>
  chord.mods.map((mod) => SYMBOL[mod]).join('') + chord.key.toUpperCase();

function tableFor(mods: Mod[]): Record<string, Command> {
  const table: Record<string, Command> = {};
  for (const { command, chords } of BINDINGS)
    for (const chord of chords) if (chord.mods.join() === mods.join()) table[chord.key] = command;
  return table;
}

const PLAIN = tableFor(['mod']);
const ALT = tableFor(['mod', 'alt']);
const SHIFT = tableFor(['mod', 'shift']);

export function commandFor(event: KeyboardEvent): Command | undefined {
  // Either modifier: the platform is not sniffable (and browsers differ). The list overlay
  // captures Ctrl+J/K itself, so plain Ctrl+K never reaches this.
  if (!(event.metaKey || event.ctrlKey)) return undefined;
  const key = event.key.toLowerCase();
  // Shift wins over alt, as it always has: no binding uses both together.
  if (event.shiftKey) return SHIFT[key];
  if (event.altKey) return ALT[key];
  return PLAIN[key];
}
