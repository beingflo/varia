import { batch, createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { Item } from '../db/api';
import { useRepo } from '../db/context';
import { onCommand, onEditorFocus } from '../lib/commands';
import { registerFlush } from '../lib/flush';
import { signalViewReady } from '../lib/ready';
import { ago } from '../lib/time';

export default function TodoView(props: { id: string }) {
  const repo = useRepo();
  const [showDone, setShowDone] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [title, setTitle] = createSignal('');
  const [saved, setSaved] = createSignal('');
  const [updated, setUpdated] = createSignal(0);
  const [editing, setEditing] = createSignal<string | null>(null);
  const [items, setItems] = createSignal<Item[]>([]);
  let addInput: HTMLInputElement | undefined;

  const reload = async () => {
    setItems(await repo.items(props.id, showDone()));
    setUpdated((await repo.getNote(props.id))?.updated ?? 0);
  };

  createEffect(async () => {
    const note = await repo.getNote(props.id);
    setTitle(note?.title ?? '');
    setSaved(note?.title ?? '');
    await reload();
    signalViewReady();
  });

  // Empty titles are fine — a list can stay untitled and show its placeholder.
  let inFlight: Promise<void> | null = null;
  const flush = (): Promise<void> => {
    if (!inFlight) {
      const name = title().trim();
      inFlight = (name === saved()
        ? Promise.resolve()
        : repo.setNoteMeta(props.id, { title: name }).then(() => {
            setSaved(name);
          })
      ).finally(() => {
        inFlight = null;
      }) as Promise<void>;
    }
    return inFlight as Promise<void>;
  };

  onMount(() => {
    addInput?.focus({ preventScroll: true });
    const off = [
      registerFlush(flush),
      onCommand('save', () => void flush()),
      onCommand('toggle-done', () => {
        setShowDone(!showDone());
        void reload();
      }),
      onEditorFocus(() => addInput?.focus({ preventScroll: true })),
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
    await repo.addItem(props.id, text);
    // Read both, then commit the row and the cleared field in one batch: the item appears and
    // the field empties in the same frame, so neither state is seen without the other.
    const [list, note] = await Promise.all([repo.items(props.id, showDone()), repo.getNote(props.id)]);
    batch(() => {
      setItems(list);
      setUpdated(note?.updated ?? 0);
      if (draft().trim() === text) setDraft('');
    });
  };

  const toggle = async (item: Item) => {
    await repo.toggleItem(item.id);
    await reload();
  };

  const saveItem = async (item: Item, text: string) => {
    setEditing(null);
    const value = text.trim();
    if (!value) await repo.removeItem(item.id);
    else await repo.setItemText(item.id, value);
    await reload();
  };

  return (
    <main class="page">
      <div class="card">
        <input
          class="title"
          aria-label="list title"
          placeholder="Untitled list"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          onBlur={() => void flush()}
        />

        <ul class="items">
          <For each={items()}>
            {(item) => (
              <li class={item.done ? 'done' : ''}>
                <Show
                  when={editing() === item.id}
                  fallback={
                    <span class="item-row" onClick={() => void toggle(item)}>
                      <button type="button" class="item-text item-toggle" aria-pressed={item.done === 1}>
                        {item.text}
                      </button>
                      <button
                        type="button"
                        class="edit"
                        aria-label={`edit ${item.text}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(item.id);
                        }}
                      >
                        Edit
                      </button>
                    </span>
                  }
                >
                  <input
                    class="item-text item-input"
                    aria-label="edit item"
                    value={item.text}
                    ref={(el) =>
                      queueMicrotask(() => {
                        el.focus({ preventScroll: true });
                        el.setSelectionRange(el.value.length, el.value.length);
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveItem(item, e.currentTarget.value);
                    }}
                    onBlur={(e) => void saveItem(item, e.currentTarget.value)}
                  />
                </Show>
              </li>
            )}
          </For>
        </ul>

        <input
          ref={addInput}
          class="add"
          aria-label="new item"
          placeholder="todo"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => void add()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
      </div>

      <Show when={updated()}>
        <span class="stamp muted small">{ago(updated())}</span>
      </Show>
    </main>
  );
}
