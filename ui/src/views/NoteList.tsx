import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { useRepo } from '../db/context';
import type { NoteSummary } from '../db/api';
import { isDashboard } from '../lib/board';
import { ago } from '../lib/time';

/** The reserved tag journal entries carry: hidden from the note list, its own section in search. */
const LOG = 'log';
/** Tags in the palette are a shortcut, not a section; a `#` query asks for them all. */
const TAG_HINT = 4;
/** Log entries answer a query too, but only the first few: the stream is one click away. */
const LOG_HINT = 4;

type Page = { notes: NoteSummary[]; logs: NoteSummary[]; logTotal: number };

/** Fullscreen, opaque, keyboard driven: ⌘K opens it, Esc closes it, arrows and Enter pick. */
export default function NoteList(props: {
  onOpen: (note: NoteSummary) => void;
  onClose: () => void;
  /** The note that is open behind the list, marked so you can see where you are. */
  currentId?: string;
  /** Hidden from the list, for a picker that already holds them: a board cannot hold a board. */
  exclude?: (note: NoteSummary) => boolean;
  /** Given by the palette, not by a picker: makes tags rows that open a stream. */
  onTag?: (tag: string) => void;
}) {
  const repo = useRepo();
  const [q, setQ] = createSignal('');
  const [cursor, setCursor] = createSignal(0);

  // A leading `#` means "I am naming a tag": then only tags answer, and all of them.
  const tagMode = () => q().trim().startsWith('#');
  const term = () => q().trim().replace(/^#/, '').trim();

  // Tags are listed before anything is typed: the streams are a place to go, not only a match.
  const [tags, { refetch: refetchTags }] = createResource(
    () => (props.onTag ? term().toLowerCase() : null),
    async (prefix) => (prefix === null ? [] : (await repo.tags()).filter((name) => name.toLowerCase().startsWith(prefix))),
  );
  const tagNames = (): string[] => (tags() ?? []).slice(0, tagMode() ? undefined : TAG_HINT);

  // Filtered here rather than in the fetch, so a picker hides what it already holds without a
  // second round trip — and the cursor indexes the same list the rows do.
  const visible = (notes: NoteSummary[]) => notes.filter((note) => !props.exclude?.(note));

  const [page, { refetch }] = createResource(
    () => ({ query: term(), onlyTags: tagMode() }),
    async ({ query, onlyTags }): Promise<Page> => {
      if (onlyTags) return { notes: [], logs: [], logTotal: 0 };
      return {
        notes: visible(await repo.listNotes({ q: query, excludeTag: LOG })),
        logs: await repo.listNotes({ q: query, tag: LOG, limit: LOG_HINT }),
        logTotal: await repo.countNotes({ q: query, tag: LOG }),
      };
    },
  );
  // The previous page stays on screen while the next one loads: typing must not blank the list.
  const [lastPage, setLastPage] = createSignal<Page>();
  createEffect(() => {
    const loaded = page();
    if (loaded) setLastPage(loaded);
  });
  const shown = () => page() ?? lastPage();
  const noteList = (): NoteSummary[] => shown()?.notes ?? [];
  const logList = (): NoteSummary[] => shown()?.logs ?? [];
  /** The flat order the cursor walks, which is also the order on screen: notes, logs, then tags. */
  const rows = (): number => tagNames().length + noteList().length + logList().length;

  createEffect(() => {
    q();
    setCursor(0);
  });

  const pick = (index: number) => {
    const notes = noteList();
    const note = notes[index] ?? logList()[index - notes.length];
    if (note) return props.onOpen(note);
    const tag = tagNames()[index - notes.length - logList().length];
    if (tag) props.onTag?.(tag);
  };

  const move = (delta: number) => {
    const last = Math.max(0, rows() - 1);
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
    const stop = repo.onChange?.(() => {
      void refetch();
      void refetchTags();
    });
    onCleanup(() => stop?.());
  });
  onCleanup(() => window.removeEventListener('keydown', onKey, true));

  const noteRow = (note: NoteSummary, index: number, log: boolean) => (
    <li class={index === cursor() ? 'on' : ''}>
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
  );

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

      <Show when={shown()}>
        {(loaded) => (
          <>
            <Show when={!tagMode()}>
              <Show when={props.onTag}>
                <h2 class="row-head">notes</h2>
              </Show>
              <ul class="notes">
                <For each={noteList()} fallback={<li class="muted">{term() ? 'no match' : 'nothing yet'}</li>}>
                  {(note, index) => noteRow(note, index(), false)}
                </For>
              </ul>

              <Show when={logList().length}>
                <h2 class="row-head">
                  logs <span class="muted small">{(loaded() as { logTotal: number }).logTotal}</span>
                </h2>
                <ul class="notes">
                  <For each={logList()}>
                    {(note, index) => noteRow(note, noteList().length + index(), true)}
                  </For>
                </ul>
              </Show>
            </Show>

            <Show when={tagNames().length}>
              <h2 class="row-head">tags</h2>
              <ul class="notes">
                <For each={tagNames()}>
                  {(name, index) => (
                    <li class={(tagMode() ? 0 : noteList().length + logList().length) + index() === cursor() ? 'on' : ''}>
                      <a
                        href={`${import.meta.env.BASE_URL}tag/${name}`}
                        onClick={(e) => {
                          e.preventDefault();
                          props.onTag?.(name);
                        }}
                      >
                        <span class="dot" aria-hidden="true" />
                        <span class="title-text">#{name}</span>
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={tagMode() && !tagNames().length}>
              <p class="muted small">no tag matches</p>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
