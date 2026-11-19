import { createResource, createSignal, For, onMount, Show } from 'solid-js';
import { useRepo } from '../db/context';
import { navigate } from '../lib/route';

export default function TodoView(props: { id: string }) {
  const repo = useRepo();
  const [showDone, setShowDone] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [note, { refetch: refetchNote }] = createResource(() => props.id, (id) => repo.getNote(id));
  const [items, { refetch }] = createResource(
    () => ({ id: props.id, showDone: showDone() }),
    ({ id, showDone }) => repo.items(id, showDone),
  );

  const reload = () => {
    void refetch();
    void refetchNote();
  };

  onMount(() => repo.onChange?.(reload));

  const add = async () => {
    const text = draft().trim();
    if (!text) return;
    setDraft('');
    await repo.addItem(props.id, text);
    reload();
  };

  const rename = async (title: string) => {
    if (!title.trim() || title === note()?.title) return;
    await repo.setNoteMeta(props.id, { title: title.trim() });
    void refetchNote();
  };

  return (
    <main>
      <header>
        <a href="/" onClick={(e) => (e.preventDefault(), navigate('/'))}>
          ← back
        </a>
        <label class="muted">
          <input type="checkbox" checked={showDone()} onChange={(e) => setShowDone(e.currentTarget.checked)} /> show
          done
        </label>
      </header>

      <Show when={note()} fallback={<p class="muted">missing list</p>}>
        {(current) => (
          <input
            class="title-input"
            aria-label="list title"
            value={current().title}
            onBlur={(e) => void rename(e.currentTarget.value)}
          />
        )}
      </Show>

      <ul class="items">
        <For each={items() ?? []}>
          {(item) => (
            <li class={item.done ? 'done' : ''}>
              <input
                type="checkbox"
                aria-label={item.text}
                checked={item.done === 1}
                onChange={async () => {
                  await repo.toggleItem(item.id);
                  reload();
                }}
              />
              <input
                class="item-text"
                aria-label={item.text}
                value={item.text}
                onBlur={async (e) => {
                  await repo.setItemText(item.id, e.currentTarget.value);
                  reload();
                }}
              />
              <button
                type="button"
                class="quiet"
                aria-label={`delete ${item.text}`}
                onClick={async () => {
                  await repo.removeItem(item.id);
                  reload();
                }}
              >
                ×
              </button>
            </li>
          )}
        </For>
      </ul>

      <input
        class="add"
        aria-label="new item"
        placeholder="add item"
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void add();
        }}
      />
    </main>
  );
}
