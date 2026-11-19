import { batch, createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { Item } from '../db/api';
import { useRepo } from '../db/context';
import { between } from '../db/ops';
import { onCommand, onEditorFocus } from '../lib/commands';
import { registerFlush } from '../lib/flush';
import { signalViewReady } from '../lib/ready';
import { ago } from '../lib/time';

const INDENT_REM = 1.4;
const WARN_MS = 1200;

/** Keep object identity for rows whose visible fields did not change, so the DOM (and focus) survive a reconcile. */
function merge(current: Item[], next: Item[]): Item[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  return next.map((row) => {
    const old = byId.get(row.id);
    const same =
      old &&
      old.text === row.text &&
      old.done === row.done &&
      old.depth === row.depth &&
      old.ordering === row.ordering &&
      old.deleted === row.deleted;
    return same ? old : row;
  });
}

export default function TodoView(props: { id: string }) {
  const repo = useRepo();
  const [showDone, setShowDone] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  // Tab in the add field indents the item that Enter will create.
  const [draftDepth, setDraftDepth] = createSignal(0);
  const [title, setTitle] = createSignal('');
  const [savedTitle, setSavedTitle] = createSignal('');
  const [updated, setUpdated] = createSignal(0);
  const [all, setAll] = createSignal<Item[]>([]);
  const [warnAt, setWarnAt] = createSignal<{ id: string; left: number } | null>(null);
  let addInput: HTMLInputElement | undefined;
  let warnTimer: ReturnType<typeof setTimeout> | undefined;
  // Reconciles can rebuild a row (its depth or text changed), which drops focus; remember which
  // item was being edited so it can be taken back.
  let focusedId: string | null = null;
  const inputs = new Map<string, HTMLInputElement>();
  // Items whose text was actually edited in this focus session. Only those are written on blur,
  // so an emptied item is deleted, but a row rebuilt mid-edit (indent, dedent) is left alone.
  const touched = new Set<string>();

  const visible = () => (showDone() ? all() : all().filter((item) => item.done === 0));

  // Reads are asynchronous, so an older one must never overwrite the list a newer one produced
  // (that would drop a just-inserted row and, with it, an item being typed into).
  let reloadGeneration = 0;

  const reload = async () => {
    const mine = ++reloadGeneration;
    const [items, note] = await Promise.all([repo.items(props.id, true), repo.getNote(props.id)]);
    if (mine !== reloadGeneration) return;
    batch(() => {
      setAll((current) => merge(current, items));
      setUpdated(note?.updated ?? 0);
    });
    queueMicrotask(restoreFocus);
  };

  /** Focus is only taken back from nowhere (body), never from an element the user chose. */
  const idle = () => !document.activeElement || document.activeElement === document.body;

  /**
   * Focus a row's input. `force` is for the direct consequence of a keystroke (Enter inserts a
   * row): the caret must move there even though the previous row's input still has focus. The
   * retry runs a frame later, after a reconcile, and then never steals.
   */
  const focusItem = (id: string, force = false) => {
    const take = (allowSteal: boolean) => {
      const input = inputs.get(id);
      if (!input?.isConnected) return false;
      if (!allowSteal && !idle() && document.activeElement !== input) return false;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      return true;
    };
    if (!take(force)) requestAnimationFrame(() => take(false));
  };

  const refocusAdd = () => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== addInput) return;
    addInput?.focus({ preventScroll: true });
  };

  const restoreFocus = () => {
    if (!focusedId || !idle()) return;
    const input = inputs.get(focusedId);
    if (!input?.isConnected) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  };

  const reconcile = async () => {
    try {
      await reload();
    } catch (err) {
      console.error('todo list refresh failed', err);
    }
  };

  createEffect(async () => {
    setDraftDepth(0); // a different list starts its placeholder at the top again
    const note = await repo.getNote(props.id);
    setTitle(note?.title ?? '');
    setSavedTitle(note?.title ?? '');
    await reload();
    signalViewReady();
  });

  /** ⌘S saves whatever is being edited: the focused item's text, then the title. */
  const flush = (): Promise<void> => {
    const run = async () => {
      const id = focusedId;
      const input = id ? inputs.get(id) : undefined;
      const item = id ? all().find((row) => row.id === id) : undefined;
      if (id && input?.isConnected && item && touched.delete(id)) await commitText(item, input.value);

      const name = title().trim(); // empty titles are fine: the list stays untitled
      if (name === savedTitle()) return;
      await repo.setNoteMeta(props.id, { title: name });
      setSavedTitle(name);
    };
    queue = queue.then(run).catch((err) => console.error('save failed', err));
    return queue;
  };

  // Which item input has focus. Tracked at document level: rebuilding a row fires focusout on the
  // removed node, and a per-input blur handler cannot tell that apart from a real blur.
  const trackFocus = (event: FocusEvent) => {
    const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('.item-text');
    focusedId = input?.dataset.item ?? null;
  };

  // Saves are serialised so a title and an item write cannot interleave.
  let queue: Promise<void> = Promise.resolve();

  onMount(() => {
    addInput?.focus({ preventScroll: true });
    document.addEventListener('focusin', trackFocus);
    const off = [
      registerFlush(flush),
      onCommand('save', () => void flush()),
      onCommand('toggle-done', () => setShowDone(!showDone())),
      onEditorFocus(() => addInput?.focus({ preventScroll: true })),
    ];
    const stop = repo.onChange?.(() => void reload());
    onCleanup(() => {
      off.forEach((unregister) => unregister());
      stop?.();
      clearTimeout(warnTimer);
      document.removeEventListener('focusin', trackFocus);
    });
  });

  // ---------------------------------------------------------------- helpers

  const indexOf = (id: string) => all().findIndex((item) => item.id === id);

  /** Rows after `item` that are nested under it, done or not. */
  const descendants = (item: Item): Item[] => {
    const list = all();
    const out: Item[] = [];
    for (let i = indexOf(item.id) + 1; i < list.length && list[i].depth > item.depth; i++) out.push(list[i]);
    return out;
  };

  const patch = (id: string, change: Partial<Item>) =>
    setAll((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item)));

  /** The tilde sits right after the item's text, so its width is measured in that font. */
  const warn = (item: Item) => {
    const input = inputs.get(item.id);
    let left = 0;
    if (input) {
      const style = getComputedStyle(input);
      const context = document.createElement('canvas').getContext('2d');
      if (context) {
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        left = context.measureText(input.value || item.text).width;
      }
    }
    setWarnAt({ id: item.id, left });
    clearTimeout(warnTimer);
    warnTimer = setTimeout(() => setWarnAt(null), WARN_MS);
  };

  /** The deepest level this item may take: one below its previous sibling, 0 for the first row. */
  const maxDepth = (item: Item): number => {
    const list = all();
    const index = indexOf(item.id);
    return index > 0 ? list[index - 1].depth + 1 : 0;
  };

  // ---------------------------------------------------------------- mutations

  const setDepth = async (item: Item, depth: number) => {
    const target = Math.max(0, Math.min(depth, maxDepth(item)));
    if (target === item.depth) return;
    const delta = target - item.depth;
    const moving = [item, ...descendants(item)];
    batch(() => setAll((list) => list.map((row) => (moving.some((m) => m.id === row.id) ? { ...row, depth: row.depth + delta } : row))));
    focusItem(item.id, true); // the row was rebuilt, so the caret has to be put back
    try {
      for (const row of moving) await repo.setItemDepth(row.id, row.depth + delta);
    } finally {
      await reconcile();
      focusItem(item.id);
    }
  };

  const commitText = async (item: Item, value: string) => {
    const text = value.trim();
    if (!text) {
      // An emptied item is removed — this is how items are deleted.
      batch(() => setAll((list) => list.filter((row) => row.id !== item.id)));
      try {
        await repo.removeItem(item.id);
      } finally {
        await reconcile();
      }
      return;
    }
    if (text === item.text) return;
    batch(() => patch(item.id, { text }));
    try {
      await repo.setItemText(item.id, text);
    } finally {
      await reconcile();
    }
  };

  const insertAfter = async (item: Item | undefined, depth: number, text = '', focusNew = true) => {
    const list = all();
    const id = crypto.randomUUID();
    let ordering: number;
    if (!item) {
      const last = list.at(-1);
      ordering = between(last?.ordering ?? null, null);
    } else {
      const index = indexOf(item.id);
      let next: Item | undefined;
      for (let i = index + 1; i < list.length; i++) {
        if (list[i].depth <= item.depth) {
          next = list[i];
          break;
        }
      }
      ordering = between(item.ordering, next?.ordering ?? null);
    }
    const row: Item = {
      id,
      note_id: props.id,
      text,
      done: 0,
      ordering,
      depth,
      deleted: 0,
      updated: Date.now(),
      stamps: '{}',
    };
    batch(() => setAll([...list, row].sort((a, b) => a.ordering - b.ordering)));
    if (focusNew) focusItem(id, true);
    try {
      await repo.addItem(props.id, text, id, depth, ordering);
    } finally {
      await reconcile();
      // Keep typing in the add field when the item was added from there.
      if (focusNew) focusItem(id, true);
      else refocusAdd();
    }
  };

  const toggle = async (item: Item) => {
    // Checking a parent off while its children are still open would hide them with it.
    if (item.done === 0 && descendants(item).some((child) => child.done === 0)) {
      warn(item);
      return;
    }
    const done = item.done ? 0 : 1;
    batch(() => patch(item.id, { done }));
    try {
      await repo.toggleItem(item.id);
    } finally {
      await reconcile();
    }
  };

  /** A new item may be nested one level under the last row; deeper than that is clamped on insert. */
  const deepestDraftDepth = () => (all().length ? all()[all().length - 1].depth + 1 : 0);

  const changeDraftDepth = (delta: number) => {
    setDraftDepth((depth) => Math.max(0, Math.min(depth + delta, deepestDraftDepth())));
  };

  /** Enter in the add field: an empty field steps the pending item out one level, like an item. */
  const enterDraft = () => {
    if (!draft().trim()) {
      changeDraftDepth(-1);
      return;
    }
    void add();
  };

  const add = async () => {
    const text = draft().trim();
    if (!text) return;
    const depth = Math.min(draftDepth(), deepestDraftDepth());
    // Row and cleared field in one batch, with the text already in it: no half-added frame.
    batch(() => setDraft('')); // the indent level is kept: the next item goes to the same depth
    try {
      await insertAfter(undefined, depth, text, false);
    } finally {
      await reconcile();
    }
  };

  const previousVisible = (item: Item): Item | undefined => {
    const list = visible();
    const index = list.findIndex((row) => row.id === item.id);
    return index > 0 ? list[index - 1] : undefined;
  };

  /** Backspace in an empty item removes it and puts the caret at the end of the item above. */
  const removeAndGoBack = async (item: Item) => {
    const previous = previousVisible(item);
    touched.delete(item.id);
    batch(() => setAll((list) => list.filter((row) => row.id !== item.id)));
    if (previous) focusItem(previous.id, true);
    try {
      await repo.removeItem(item.id);
    } finally {
      await reconcile();
      if (previous) focusItem(previous.id);
    }
  };

  const onItemKeyDown = (item: Item, event: KeyboardEvent) => {
    const value = (event.currentTarget as HTMLInputElement).value;
    if (event.key === 'Enter') {
      event.preventDefault();
      void (async () => {
        if (!value.trim()) {
          // Empty item: step out one level. Never commit here — an empty item that blurs is deleted.
          if (item.depth > 0) await setDepth(item, item.depth - 1);
          return;
        }
        touched.delete(item.id);
        await commitText(item, value);
        await insertAfter(item, item.depth);
      })();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      void setDepth(item, item.depth + (event.shiftKey ? -1 : 1));
    } else if (event.key === 'Backspace' && !value) {
      event.preventDefault();
      void removeAndGoBack(item);
    }
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
          <For each={visible()}>
            {(item) => (
              <li
                class={item.done ? 'done' : ''}
                style={{ 'padding-left': `${item.depth * INDENT_REM}rem` }}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey) {
                    event.preventDefault();
                    void toggle(item);
                  }
                }}
              >
                <span class="bullet" aria-hidden="true" />
                <span class="item-body">
                <input
                  class="item-text"
                  data-item={item.id}
                  aria-label={item.text || 'empty item'}
                  value={item.text}
                  ref={(el) => {
                    inputs.set(item.id, el);
                  }}
                  onInput={() => touched.add(item.id)}
                  onBlur={(e) => {
                    // A row rebuilt by the list (reconcile, indent) also fires blur; only a blur of
                    // a row the user actually edited may write — and delete, when it was emptied.
                    const input = e.target as HTMLInputElement;
                    if (!input.isConnected) return;
                    if (!touched.delete(item.id)) return;
                    void commitText(item, input.value);
                  }}
                  onKeyDown={(e) => onItemKeyDown(item, e)}
                />
                <Show when={warnAt()?.id === item.id}>
                  <span
                    class="item-warn"
                    style={{ left: `calc(${warnAt()?.left ?? 0}px + 0.4rem)` }}
                    aria-label="cannot check off: nested items are open"
                  >
                    ~
                  </span>
                </Show>
                </span>
              </li>
            )}
          </For>
        </ul>

        <div
          class={draft().trim() ? 'item-add filled' : 'item-add'}
          style={{ 'padding-left': `${draftDepth() * INDENT_REM}rem` }}
        >
          <span class="bullet" aria-hidden="true" />
          <input
            ref={addInput}
            class="add"
            aria-label="new item"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onBlur={() => void add()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                enterDraft();
              } else if (e.key === 'Tab') {
                e.preventDefault();
                changeDraftDepth(e.shiftKey ? -1 : 1);
              }
            }}
          />
        </div>
      </div>

      <Show when={updated()}>
        <span class="stamp muted small">{ago(updated())}</span>
      </Show>
    </main>
  );
}
