import { createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { useRepo } from '../db/context';
import type { NoteSummary } from '../db/api';
import { tagsOfLastLine } from '../db/ops';
import { isDashboard, parseBoard } from '../lib/board';
import { onCommand } from '../lib/commands';
import { stamp } from '../lib/time';
import NoteView from './NoteView';

/** One page of entries; "older" asks for the next. A year of journaling is 20 clicks away. */
const PAGE = 25;

/**
 * A tag as a stream: every text note carrying it, newest first, whole bodies and no chrome. Not a
 * note type — the view is the tag (design/004), so nothing is stored for it and any note can be an
 * entry by naming the tag on its last line.
 */
export default function TagView(props: { tag: string; onOpen: (note: NoteSummary) => void }) {
  const repo = useRepo();
  const [limit, setLimit] = createSignal(PAGE);
  const [draft, setDraft] = createSignal(false);
  // The note a draft has already become: it stays in the draft block until ⌘S ends the entry, so
  // it must not also appear as a read-only row underneath.
  const [draftId, setDraftId] = createSignal<string>();

  const [page, { refetch }] = createResource(
    () => ({ tag: props.tag, limit: limit() }),
    // One extra row: its presence is what says there is an older page to offer.
    async ({ tag, limit: size }) => ({
      notes: await repo.listNotes({ tag, kind: 'note', sort: 'created', limit: size + 1 }),
      total: await repo.countNotes({ tag, kind: 'note' }),
    }),
  );

  const rows = () => (page()?.notes ?? []).slice(0, limit()).filter((note) => note.id !== draftId());
  const more = () => (page()?.notes ?? []).length > limit();

  const tagsForDraft = () => [props.tag];

  // Only ⌘S ends an entry: a background flush (a sync, the tab going away) saves it silently and
  // leaves you writing. `runCommand('save')` calls this after the flush, so the note exists.
  const endDraft = () => {
    if (!draft()) return;
    setDraft(false);
    setDraftId(undefined);
    void refetch();
  };

  onMount(() => {
    const off = [
      onCommand('new-entry', () => setDraft(true)),
      onCommand('save', endDraft),
      repo.onChange?.(() => void refetch()) ?? (() => {}),
    ];
    onCleanup(() => off.forEach((unregister) => unregister()));
  });

  const open = (note: NoteSummary) => (event: MouseEvent) => {
    // Plain click stays in the app; a modified click is the browser's (a new tab).
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    props.onOpen(note);
  };

  /**
   * The entry as it is written, minus its closing tag line, plus that line kept apart so it can be
   * drawn muted the way the editor draws it. The stream repeats it on purpose: it is the entry's
   * own record of which streams it belongs to.
   */
  const parts = (note: NoteSummary) => {
    const lines = note.body.split('\n');
    let last = lines.length - 1;
    while (last >= 0 && !lines[last].trim()) last -= 1;
    const tags = tagsOfLastLine(note.body);
    const head = isDashboard(note.body)
      ? (() => {
          // A board's body is a layout, not writing: one line naming it instead of raw JSON.
          const tiles = parseBoard(note.body).tiles.length;
          return `${note.title || '(untitled)'} — ▦ ${tiles} ${tiles === 1 ? 'tile' : 'tiles'}`;
        })()
      : lines.slice(0, last).join('\n').replace(/\n+$/, '');
    return { head, foot: tags.length ? lines[last] : '' };
  };

  return (
    <main class="tag-page" aria-label={`entries tagged ${props.tag}`}>
      <header class="tag-head">
        <h1>{props.tag}</h1>
        <span class="tag-count">
          {page()?.total ?? 0} {(page()?.total ?? 0) === 1 ? 'entry' : 'entries'}
        </span>
      </header>

      <Show when={draft()}>
        <div class="tag-draft">
          <NoteView
            embedded
            autoFocus
            tags={tagsForDraft()}
            onCreated={(id) => {
              setDraftId(id);
              void refetch();
            }}
          />
        </div>
      </Show>

      <For each={rows()}>
        {(note) => (
          <article class="tag-entry">
            <div class="tag-text">
              {parts(note).head}
              <Show when={parts(note).foot}>
                {parts(note).head ? '\n' : ''}
                <span class="tag-foot">{parts(note).foot}</span>
              </Show>
            </div>
            <a class="tag-when" href={`${import.meta.env.BASE_URL}note/${note.id}`} onClick={open(note)}>
              {stamp(note.created)}
            </a>
          </article>
        )}
      </For>

      <Show when={!rows().length && !draft()}>
        <p class="muted">nothing tagged #{props.tag} yet</p>
      </Show>

      <Show when={more()}>
        <button type="button" class="tag-more" onClick={() => setLimit(limit() + PAGE)}>
          load older
        </button>
      </Show>
    </main>
  );
}
