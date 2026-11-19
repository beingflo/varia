import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { useRepo } from '../db/context';
import { onCommand, onEditorFocus } from '../lib/commands';
import { registerFlush } from '../lib/flush';
import { signalViewReady } from '../lib/ready';

export default function TodoView(props: { id: string }) {
  const repo = useRepo();
  const [showDone, setShowDone] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [title, setTitle] = createSignal('');
  const [saved, setSaved] = createSignal('');
  const [items, setItems] = createSignal<Awaited<ReturnType<typeof repo.items>>>([]);
  let titleInput: HTMLInputElement | undefined;

  const reload = async () => setItems(await repo.items(props.id, showDone()));

  createEffect(async () => {
    const note = await repo.getNote(props.id);
    setTitle(note?.title ?? '');
    setSaved(note?.title ?? '');
    await reload();
    signalViewReady();
  });

  let inFlight: Promise<void> | null = null;

  const flush = (): Promise<void> => {
    if (!inFlight) inFlight = doFlush().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const doFlush = async () => {
    const name = title().trim();
    if (!name || name === saved()) return;
    await repo.setNoteMeta(props.id, { title: name });
    setSaved(name);
  };

  onMount(() => {
    titleInput?.focus();
    const off = [
      registerFlush(flush),
      onEditorFocus(() => titleInput?.focus()),
      onCommand('save', () => void flush()),
      onCommand('toggle-done', () => {
        setShowDone(!showDone());
        void reload();
      }),
    ];
    const stop = repo.onChange?.(() => void reload());
    onCleanup(() => {
      off.forEach((unregister) => unregister());
      stop?.();
    });
  });

  const add = async () => {
    const text = draft().trim();
    if (!text) return;
    setDraft('');
    await repo.addItem(props.id, text);
    await reload();
  };

  return (
    <main class="page">
      <div class="card">
      <input
        ref={titleInput}
        class="title"
        aria-label="list title"
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
        onBlur={() => void flush()}
      />

      <ul class="items">
        <For each={items()}>
          {(item) => (
            <li class={item.done ? 'done' : ''}>
              <input
                type="checkbox"
                aria-label={item.text}
                checked={item.done === 1}
                onChange={async () => {
                  await repo.toggleItem(item.id);
                  await reload();
                }}
              />
              <input
                class="item-text"
                aria-label={item.text}
                value={item.text}
                onBlur={async (e) => {
                  const text = e.currentTarget.value.trim();
                  if (!text) await repo.removeItem(item.id);
                  else await repo.setItemText(item.id, text);
                  await reload();
                }}
              />
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
        onBlur={() => void add()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void add();
        }}
      />

      <Show when={showDone()}>
        <p class="muted small">showing done</p>
      </Show>
      </div>
    </main>
  );
}
