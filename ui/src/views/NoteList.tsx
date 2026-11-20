import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { useRepo } from '../db/context';
import type { NoteSummary } from '../db/api';
import { isDashboard } from '../lib/board';
import { ago } from '../lib/time';

/** Fullscreen, opaque, keyboard driven: ⌘K opens it, Esc closes it, arrows and Enter pick. */
export default function NoteList(props: {
  onOpen: (note: NoteSummary) => void;
  onClose: () => void;
  /** The note that is open behind the list, marked so you can see where you are. */
  currentId?: string;
  /** Hidden from the list, for a picker that already holds them: a board cannot hold a board. */
  exclude?: (note: NoteSummary) => boolean;
}) {
  const repo = useRepo();
  const [q, setQ] = createSignal('');
  const [cursor, setCursor] = createSignal(0);

  const [notes, { refetch }] = createResource(() => q().trim(), (query) => repo.listNotes({ q: query }));
  // Filtered here rather than in the fetch, so a picker hides what it already holds without a
  // second round trip — and the cursor indexes the same list the rows do.
  const visible = () => (notes() ?? []).filter((note) => !props.exclude?.(note));

  createEffect(() => {
    q();
    setCursor(0);
  });

  const pick = (index: number) => {
    const note = visible()[index];
    if (note) props.onOpen(note);
  };

  const move = (delta: number) => {
    const last = Math.max(0, visible().length - 1);
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
      <button type="button" class="overlay-close" onClick={props.onClose}>
        close
      </button>
      <input
        ref={search}
        class="search"
        type="search"
        placeholder="search"
        aria-label="search notes"
        value={q()}
        onInput={(e) => setQ(e.currentTarget.value)}
      />

      <Show when={notes()}>
        {(list) => (
      <ul class="notes">
        <For each={visible()} fallback={<li class="muted">nothing yet</li>}>
          {(note, index) => (
            <li class={index() === cursor() ? 'on' : ''}>
              <a
                href="/"
                aria-current={note.id === props.currentId ? 'true' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  props.onOpen(note);
                }}
              >
                <span class="dot" aria-hidden="true">
                  {note.id === props.currentId ? '•' : ''}
                </span>
                <span class={note.title ? 'title-text' : 'title-text muted'}>
                  {note.title || '(untitled)'}
                  {isDashboard(note.body) ? ' ▦' : note.kind === 'todo' ? ' ~' : ''}
                </span>
                <span class="muted small">{ago(note.updated)}</span>
              </a>
            </li>
          )}
        </For>
      </ul>
        )}
      </Show>
    </section>
  );
}
