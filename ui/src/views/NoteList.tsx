import { createEffect, createResource, createSignal, For, onCleanup, onMount } from 'solid-js';
import { useRepo } from '../db/context';
import type { NoteSummary } from '../db/api';
import { ago } from '../lib/time';

/** Fullscreen, opaque, keyboard driven: ⌘K opens it, Esc closes it, arrows and Enter pick. */
export default function NoteList(props: { onOpen: (note: NoteSummary) => void; onClose: () => void }) {
  const repo = useRepo();
  const [q, setQ] = createSignal('');
  const [cursor, setCursor] = createSignal(0);

  const [notes, { refetch }] = createResource(() => q().trim(), (query) => repo.listNotes({ q: query }));

  createEffect(() => {
    q();
    setCursor(0);
  });

  const pick = (index: number) => {
    const note = (notes() ?? [])[index];
    if (note) props.onOpen(note);
  };

  const move = (delta: number) => {
    const last = Math.max(0, (notes()?.length ?? 1) - 1);
    setCursor(Math.min(Math.max(cursor() + delta, 0), last));
  };

  const onKey = (event: KeyboardEvent) => {
    // Vim-style Ctrl+J/K. Captured so the global ⌘K handler cannot see Ctrl+K.
    if (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'j' || event.key === 'k')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      move(event.key === 'j' ? 1 : -1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      props.onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(cursor());
    }
  };

  let search: HTMLInputElement | undefined;
  onMount(() => {
    search?.focus();
    window.addEventListener('keydown', onKey, true);
    // Another tab wrote: show it without reopening the list.
    const stop = repo.onChange?.(() => void refetch());
    onCleanup(() => stop?.());
  });
  onCleanup(() => window.removeEventListener('keydown', onKey, true));

  return (
    <section class="overlay" aria-label="notes">
      <input
        ref={search}
        class="search"
        type="search"
        placeholder="search"
        aria-label="search notes"
        value={q()}
        onInput={(e) => setQ(e.currentTarget.value)}
      />

      <ul class="notes">
        <For each={notes() ?? []} fallback={<li class="muted">nothing yet</li>}>
          {(note, index) => (
            <li class={index() === cursor() ? 'on' : ''} onMouseEnter={() => setCursor(index())}>
              <a
                href="/"
                onClick={(e) => {
                  e.preventDefault();
                  props.onOpen(note);
                }}
              >
                <span class={note.title ? '' : 'muted'}>{note.title || '(untitled)'}</span>
                <span class="muted small">{note.kind === 'todo' ? `${note.open_items} open` : ago(note.updated)}</span>
              </a>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
