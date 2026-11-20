import { For } from 'solid-js';
import { runCommand, type Command } from '../lib/commands';

/** A touch screen has no cheatsheet: the commands the shortcuts stand for, as buttons. */
const ACTIONS: Record<'note' | 'todo', { command: Command; label: string }[]> = {
  note: [
    { command: 'list', label: 'notes' },
    { command: 'new-note', label: 'new note' },
    { command: 'new-list', label: 'new list' },
    { command: 'history', label: 'versions' },
    { command: 'sync', label: 'sync' },
  ],
  todo: [
    { command: 'list', label: 'notes' },
    { command: 'new-note', label: 'new note' },
    { command: 'new-list', label: 'new list' },
    { command: 'toggle-done', label: 'done' },
    { command: 'sync', label: 'sync' },
  ],
};

/** Hidden by CSS on anything with a keyboard. */
export default function MobileBar(props: { kind: 'note' | 'todo' }) {
  return (
    <nav class="mobile-bar" aria-label="actions">
      <For each={ACTIONS[props.kind]}>
        {(action) => (
          <button type="button" onClick={() => runCommand(action.command)}>
            {action.label}
          </button>
        )}
      </For>
    </nav>
  );
}
