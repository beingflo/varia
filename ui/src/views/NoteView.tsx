import { createEffect, createResource, createSignal, onMount, Show } from 'solid-js';
import History from '../components/History';
import { useRepo } from '../db/context';
import { navigate } from '../lib/route';
import { ago } from '../lib/time';

const DEBOUNCE_MS = 1000;

export default function NoteView(props: { id: string }) {
  const repo = useRepo();
  const [note, { refetch }] = createResource(() => props.id, (id) => repo.getNote(id));
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [tagText, setTagText] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let editor: HTMLTextAreaElement | undefined;

  onMount(() =>
    repo.onChange?.(() => {
      // Another tab changed something; only re-read when this note is not being edited.
      if (!editor?.matches(':focus')) void refetch();
    }),
  );

  createEffect(async () => {
    const current = note();
    if (current && tagText() === null) setTagText((await repo.tagsOf(current.id)).join(', '));
  });

  // No refetch after a save: a stale read landing mid-typing would rewrite the textarea
  // with the previous body, and the next blur would save that older text back.
  const save = async (body: string) => {
    clearTimeout(timer);
    await repo.saveBody(props.id, body);
  };

  const onInput = (body: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(body), DEBOUNCE_MS);
  };

  const saveTags = async () => {
    const tags = (tagText() ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    await repo.setNoteMeta(props.id, { tags });
    void refetch();
  };

  return (
    <main>
      <header>
        <a href="/" onClick={(e) => (e.preventDefault(), navigate('/'))}>
          ← back
        </a>
        <nav>
          <button type="button" onClick={() => setHistoryOpen(!historyOpen())}>
            history
          </button>
          <button
            type="button"
            onClick={async () => {
              await repo.setNoteMeta(props.id, { deleted: true });
              navigate('/');
            }}
          >
            delete
          </button>
        </nav>
      </header>

      <Show when={note()} fallback={<p class="muted">missing note</p>}>
        {(current) => (
          <>
            <textarea
              ref={editor}
              class="editor"
              aria-label="note body"
              value={current().body}
              onInput={(e) => onInput(e.currentTarget.value)}
              onBlur={(e) => void save(e.currentTarget.value)}
            />
            <div class="meta">
              <input
                class="tag-input"
                aria-label="tags"
                placeholder="tags, comma separated"
                value={tagText() ?? ''}
                onInput={(e) => setTagText(e.currentTarget.value)}
                onBlur={() => void saveTags()}
              />
              <span class="muted">{ago(current().updated)}</span>
            </div>
            <Show when={historyOpen()}>
              <History noteId={props.id} onRestore={() => void refetch()} />
            </Show>
          </>
        )}
      </Show>
    </main>
  );
}
