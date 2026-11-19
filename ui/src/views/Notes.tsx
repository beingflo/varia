import { createResource, createSignal, For, onMount, Show } from 'solid-js';
import { useRepo } from '../db/context';
import { navigate } from '../lib/route';
import { ago } from '../lib/time';

export default function Notes() {
  const repo = useRepo();
  const [q, setQ] = createSignal('');
  const [tag, setTag] = createSignal<string>();
  const [notes, { refetch }] = createResource(() => ({ q: q().trim(), tag: tag() }), (filter) => repo.listNotes(filter));
  const [tags, { refetch: refetchTags }] = createResource(() => repo.tags());
  const [device] = createResource(() => repo.deviceId());

  onMount(() =>
    repo.onChange?.(() => {
      void refetch();
      void refetchTags();
    }),
  );

  const create = async (kind: 'note' | 'todo') => {
    navigate(`/${kind}/${await repo.createNote(kind, kind === 'todo' ? 'list' : '')}`);
  };

  return (
    <main>
      <header>
        <a class="brand" href="/" onClick={(e) => (e.preventDefault(), navigate('/'))}>
          varia
        </a>
        <nav>
          <button type="button" onClick={() => void create('note')}>
            note
          </button>
          <button type="button" onClick={() => void create('todo')}>
            list
          </button>
        </nav>
      </header>

      <input
        class="search"
        type="search"
        placeholder="search"
        value={q()}
        onInput={(e) => setQ(e.currentTarget.value)}
      />

      <Show when={(tags() ?? []).length > 0}>
        <div class="tags">
          <For each={tags()}>
            {(name) => (
              <button
                type="button"
                class={tag() === name ? 'chip on' : 'chip'}
                onClick={() => setTag(tag() === name ? undefined : name)}
              >
                {name}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={notes.error ?? device.error}>
        {(err) => <p class="warn">database failed: {String((err() as Error)?.message ?? err())}</p>}
      </Show>

      <ul class="notes">
        <For each={notes() ?? []} fallback={<li class="muted">nothing yet</li>}>
          {(note) => (
            <li>
              <a
                href={`/${note.kind}/${note.id}`}
                onClick={(e) => (e.preventDefault(), navigate(`/${note.kind}/${note.id}`))}
              >
                <span class={note.title ? '' : 'muted'}>{note.title || '(untitled)'}</span>
                <span class="muted">
                  {note.kind === 'todo' ? `${note.open_items} open` : ago(note.updated)}
                </span>
              </a>
            </li>
          )}
        </For>
      </ul>

      <footer class="muted small">device {device()?.slice(0, 8) ?? '…'}</footer>
    </main>
  );
}
