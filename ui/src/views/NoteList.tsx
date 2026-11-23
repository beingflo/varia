import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { useRepo } from '../db/context';
import type { SearchHit, SearchPage } from '../db/api';
import { ago } from '../lib/time';

/** Tags in the palette are a shortcut, not a section; a `#` query asks for them all. */
const TAG_HINT = 4;
/** A keystroke is cheaper than a query: the list follows once the typing pauses. */
const DEBOUNCE = 120;
/** Rows drawn at most: every row is a DOM subtree, and thousands of them cost more than the query. */
const LIMIT = 200;

/** Fullscreen, opaque, keyboard driven: ⌘K opens it, Esc closes it, arrows and Enter pick. */
export default function NoteList(props: {
  onOpen: (note: SearchHit) => void;
  onClose: () => void;
  /** The note that is open behind the list, marked so you can see where you are. */
  currentId?: string;
  /** Hidden from the list, for a picker that already holds them: a board cannot hold another. */
  excludeTag?: string;
  /** Given by the palette, not by a picker: makes tags rows that open a stream. */
  onTag?: (tag: string) => void;
}) {
  const repo = useRepo();
  const [q, setQ] = createSignal('');
  const [query, setQuery] = createSignal('');
  const [cursor, setCursor] = createSignal(0);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    setQuery(q());
  };
  const settle = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE);
  };
  onCleanup(() => clearTimeout(timer));

  // A leading `#` means "I am naming a tag": then only tags answer, and all of them.
  const tagMode = () => query().trim().startsWith('#');
  const term = () => query().trim().replace(/^#/, '').trim();

  // Tags are listed before anything is typed: the streams are a place to go, not only a match.
  const [tags, { refetch: refetchTags }] = createResource(
    () => (props.onTag ? term().toLowerCase() : null),
    async (prefix) => (prefix === null ? [] : (await repo.tags()).filter((name) => name.toLowerCase().startsWith(prefix))),
  );
  const tagNames = (): string[] => (tags() ?? []).slice(0, tagMode() ? undefined : TAG_HINT);

  const [page, { refetch }] = createResource(
    () => ({ query: term(), onlyTags: tagMode() }),
    async ({ query, onlyTags }): Promise<SearchPage> =>
      onlyTags ? { hits: [], total: 0 } : repo.searchNotes({ q: query, excludeTag: props.excludeTag, limit: LIMIT }),
  );
  // The previous page stays on screen while the next one loads: typing must not blank the list.
  const [lastPage, setLastPage] = createSignal<SearchPage>();
  createEffect(() => {
    const loaded = page();
    if (loaded) setLastPage(loaded);
  });
  const shown = (): SearchPage => page() ?? lastPage() ?? { hits: [], total: 0 };
  const noteList = (): SearchHit[] => shown().hits;
  /** The flat order the cursor walks, which is also the order on screen: notes, then tags. */
  const rows = (): number => tagNames().length + noteList().length;

  createEffect(() => {
    query();
    setCursor(0);
  });

  const pick = (index: number) => {
    const note = noteList()[index];
    if (note) return props.onOpen(note);
    const tag = tagNames()[index - noteList().length];
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
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
    event.preventDefault();
    // A key that picks must never act on the previous query's rows: settle first, act on the next.
    if (q() !== query()) {
      flush();
      return;
    }
    if (event.key === 'Enter') pick(cursor());
    else move(event.key === 'ArrowDown' ? 1 : -1);
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

  const noteRow = (note: SearchHit, index: number) => (
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
          {note.kind === 'todo' ? ' ~' : ''}
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
        onInput={(e) => {
          setQ(e.currentTarget.value);
          settle();
        }}
      />

      <Show when={page() ?? lastPage()}>
        <Show when={!tagMode()}>
          <Show when={props.onTag}>
            <h2 class="row-head">notes</h2>
          </Show>
          <ul class="notes">
            <For each={noteList()} fallback={<li class="muted">{term() ? 'no match' : 'nothing yet'}</li>}>
              {(note, index) => noteRow(note, index())}
            </For>
          </ul>
          <Show when={noteList().length < shown().total}>
            <p class="muted small">{shown().total - noteList().length} more</p>
          </Show>
        </Show>

        <Show when={tagNames().length}>
          <h2 class="row-head">tags</h2>
          <ul class="notes">
            <For each={tagNames()}>
              {(name, index) => (
                <li class={(tagMode() ? 0 : noteList().length) + index() === cursor() ? 'on' : ''}>
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
      </Show>
    </section>
  );
}
