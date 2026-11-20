import { batch, createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import type { Item } from '../db/api';
import { useRepo } from '../db/context';
import { between } from '../db/ops';
import { onCommand, onEditorFocus } from '../lib/commands';
import { registerFlush } from '../lib/flush';
import { signalViewReady } from '../lib/ready';
import { ago, useTicker } from '../lib/time';

const INDENT_REM = 1.4;
const WARN_MS = 1200;

/** Keep object identity for rows whose stored fields did not change, so the DOM (and focus) survive a reload. */
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

/**
 * A list. With no `id` this is an empty draft: nothing exists in the database until an item or a
 * title is written, so ⌘⇧E followed by ⌘E leaves nothing behind.
 *
 * What is being typed lives in `edits`, not in the input, and the database is read after every
 * write instead of being guessed at. A row can then be rebuilt at any time — indent, remote op,
 * reload — without losing a keystroke, and there is one commit path instead of five.
 */
export default function TodoView(props: { id?: string; onCreated?: (id: string) => void }) {
  const repo = useRepo();
  const [noteId, setNoteId] = createSignal(props.id);
  const [showDone, setShowDone] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  // Tab in the add field indents the item that Enter will create.
  const [draftDepth, setDraftDepth] = createSignal(0);
  const [title, setTitle] = createSignal('');
  const [savedTitle, setSavedTitle] = createSignal('');
  const [updated, setUpdated] = createSignal(0);
  const now = useTicker();
  const [all, setAll] = createSignal<Item[]>([]);
  // Text typed into a row and not yet written: row id → what the input shows.
  const [edits, setEdits] = createSignal(new Map<string, string>());
  const [warnAt, setWarnAt] = createSignal<{ id: string; left: number } | null>(null);
  let addInput: HTMLInputElement | undefined;
  let titleInput: HTMLInputElement | undefined;
  let warnTimer: ReturnType<typeof setTimeout> | undefined;
  // A row can be rebuilt by a reload (depth, ordering), which drops focus; remember which row was
  // being edited so the caret can be taken back.
  let focusedId: string | null = null;
  // Depth of the row this view created last, for the moment before the reload shows it.
  let lastCreatedDepth: number | undefined;
  // Blank rows on screen that are not in the database yet: never "abandoned", they are not real.
  const localRows = new Set<string>();
  const inputs = new Map<string, HTMLInputElement>();
  // The note this view created itself: its state on screen is newer than what a read would return.
  let ownNote: string | undefined;
  // A create in flight. Two writes can arrive before the first one lands (a flush then an add);
  // without this guard each would create its own note.
  let creating: Promise<string> | undefined;

  const visible = () => (showDone() ? all() : all().filter((item) => item.done === 0));
  const textOf = (item: Item) => edits().get(item.id) ?? item.text;
  /** What the input shows for a row id, read from live state rather than a possibly stale row. */
  const pendingText = (id: string) => edits().get(id) ?? all().find((row) => row.id === id)?.text ?? '';

  // Reads are asynchronous, so an older one must never overwrite the list a newer one produced.
  let reloadGeneration = 0;

  /** The list's note, created on the first write so an untouched draft never lands in the database. */
  const ensureNote = (): Promise<string> => {
    const existing = noteId();
    if (existing) return Promise.resolve(existing);
    creating ??= (async () => {
      const id = await repo.createNote('todo');
      setNoteId(id);
      ownNote = id;
      props.onCreated?.(id);
      return id;
    })();
    return creating;
  };

  /**
   * Reads the list and hands back the rows without touching state: a caller that has to change
   * something else in the same frame (an added item, a cleared field) applies both together, so no
   * frame ever shows half of it.
   */
  const read = async (): Promise<{ items: Item[]; updated: number } | undefined> => {
    const id = noteId();
    if (!id) return undefined;
    const generation = ++reloadGeneration;
    const [items, note] = await Promise.all([repo.items(id, true), repo.getNote(id)]);
    if (generation !== reloadGeneration) return undefined;
    return { items, updated: note?.updated ?? 0 };
  };

  const apply = (data: { items: Item[]; updated: number }) =>
    batch(() => {
      // The database is the truth, except for blank rows it does not know about yet: a write
      // landing while one of those is being typed into must not take it off screen.
      setAll((current) => {
        const rows = merge(current, data.items);
        const pending = current.filter((row) => localRows.has(row.id) && !data.items.some((next) => next.id === row.id));
        return pending.length > 0 ? [...rows, ...pending].sort((a, b) => a.ordering - b.ordering) : rows;
      });
      setUpdated(data.updated);
    });

  const reload = async () => {
    const data = await read();
    if (data) apply(data);
  };

  const reconcile = async () => {
    try {
      await reload();
    } catch (err) {
      console.error('todo list refresh failed', err);
    }
    queueMicrotask(restoreFocus);
  };

  /** Focus is only taken back from nowhere (body), never from an element the user chose. */
  const idle = () => !document.activeElement || document.activeElement === document.body;

  /**
   * Focus a row's input. `force` is for the direct consequence of a keystroke (Enter inserts a
   * row): the caret must move there even though the previous row's input still has focus. The
   * retry runs a frame later, after a reload, and then never steals.
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

  /** A new list starts at its title; an existing one at the item field. */
  const focusStart = () => (props.id ? addInput : titleInput)?.focus({ preventScroll: true });

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

  createEffect(
    on(
      () => props.id,
      async (id) => {
        // The id this view just created: reloading now would read the note before the write it is
        // waiting on. Kept, so a repeat run is a no-op too.
        if (id && id === ownNote) return requestAnimationFrame(signalViewReady);
        setDraftDepth(0); // a different list starts its placeholder at the top again
        lastCreatedDepth = undefined;
        localRows.clear();
        creating = undefined;
        ownNote = undefined;
        setNoteId(id);
        setDraft('');
        setEdits(new Map());
        setAll([]);
        const note = id ? await repo.getNote(id) : undefined;
        batch(() => {
          setTitle(note?.title ?? '');
          setSavedTitle(note?.title ?? '');
        });
        await reconcile();
        requestAnimationFrame(() => {
          if (idle()) focusStart();
          signalViewReady();
        });
      },
    ),
  );

  // Which item input has focus. Tracked at document level: rebuilding a row fires focusout on the
  // removed node, and a per-input blur handler cannot tell that apart from a real blur.
  const trackFocus = (event: FocusEvent) => {
    const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('.item-text');
    focusedId = input?.dataset.item ?? null;
  };

  // Writes are serialised so a title and an item write cannot interleave.
  let queue: Promise<void> = Promise.resolve();
  const serial = (run: () => Promise<void>) => {
    queue = queue.then(run).catch((err) => console.error('todo write failed', err));
    return queue;
  };

  // The draft a queued write is already turning into an item. Enter and the blur that follows it
  // both flush, and without this the second one would add the same text again.
  let queuedDraft: string | undefined;

  /** ⌘S saves whatever is being edited: a half-typed new item, the focused row, then the title. */
  const flush = (background = false): Promise<void> => {
    const snapshot = {
      draft: draft(),
      draftDepth: draftDepth(),
      item: focusedId ? all().find((row) => row.id === focusedId) : undefined,
      title: title(),
      savedTitle: savedTitle(),
    };
    const typed = snapshot.draft.trim();
    if (typed && typed === queuedDraft) return queue; // already on its way
    if (typed) queuedDraft = typed;
    return serial(async () => {
      try {
        // A sync flushing mid-word must leave the draft alone: turning it into an item now would
        // park a half-typed copy above the field the caret is still typing in.
        if (typed && !background) await writeNew(snapshot.draft, snapshot.draftDepth);
        if (snapshot.item) await writeText(snapshot.item.id, pendingText(snapshot.item.id));
        const name = snapshot.title.trim(); // empty titles are fine: the list stays untitled
        if (name === snapshot.savedTitle) return;
        await repo.setNoteMeta(await ensureNote(), { title: name });
        setSavedTitle(name);
      } finally {
        if (queuedDraft === typed) queuedDraft = undefined;
      }
    });
  };

  onMount(() => {
    focusStart();
    document.addEventListener('focusin', trackFocus);
    const off = [
      registerFlush(flush),
      onCommand('save', () => void flush()),
      onCommand('toggle-done', () => setShowDone(!showDone())),
      onEditorFocus(() => addInput?.focus({ preventScroll: true })),
    ];
    const stop = repo.onChange?.(() => void reconcile());
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

  const setDepth = async (id: string, depth: number) => {
    const item = all().find((row) => row.id === id);
    if (!item) return;
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

  // ---------------------------------------------------------------- writes

  const dropEdit = (id: string) =>
    setEdits((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });

  /**
   * Writes a row's text and reloads: one path for blur, Enter, Tab, Backspace and ⌘S. The typed
   * text is only handed over once the reload carries it, so the input never falls back to the
   * stored text for a frame and never shows a row that is gone.
   */
  const writeText = async (id: string, value: string) => {
    const item = all().find((row) => row.id === id);
    if (!item) return;
    const text = value.trim();
    // The typed text is only given up if it is still the text this write carried: a save can be
    // started by a sync flush mid-word, and dropping the edit unconditionally would delete the
    // characters typed after the write began.
    const handOver = () => {
      if (edits().get(id) === text) dropEdit(id);
    };
    if (text === item.text) {
      handOver();
      return; // nothing to do: not a write, not a notification
    }
    try {
      if (text) await repo.setItemText(id, text);
      else await repo.removeItem(id); // an emptied row is how items are deleted
    } finally {
      const data = await read();
      batch(() => {
        if (data) apply(data);
        handOver();
      });
      queueMicrotask(restoreFocus);
    }
  };

  const nextOrderingAfter = (item: Item | undefined): number => {
    const list = all();
    if (!item) return between(list.at(-1)?.ordering ?? null, null);
    let next: Item | undefined;
    for (let i = indexOf(item.id) + 1; i < list.length; i++) {
      if (list[i].depth <= item.depth) {
        next = list[i];
        break;
      }
    }
    return between(item.ordering, next?.ordering ?? null);
  };

  /** Rows created with Enter and left empty are placeholders: adding another item drops them. */
  const abandonedRows = (): Item[] => {
    const list = all();
    return list.filter(
      (row, index) =>
        !row.text && !edits().has(row.id) && !localRows.has(row.id) && !(list[index + 1]?.depth > row.depth),
    );
  };

  /**
   * A row for the caret to move into, on screen at once: a keystroke may arrive before a write
   * could. It is empty, so there is nothing to lose if the write fails — only the row.
   */
  const addBlankRow = (after: Item, depth: number): string => {
    const row: Item = {
      id: crypto.randomUUID(),
      note_id: noteId() ?? '',
      text: '',
      done: 0,
      depth,
      ordering: nextOrderingAfter(after),
      deleted: 0,
      updated: Date.now(),
      stamps: '{}',
    };
    lastCreatedDepth = depth;
    localRows.add(row.id);
    batch(() => setAll((list) => [...list, row].sort((a, b) => a.ordering - b.ordering)));
    focusItem(row.id, true);
    void serial(async () => {
      const abandoned = abandonedRows();
      await repo.addItem(await ensureNote(), '', row.id, row.depth, row.ordering);
      for (const stale of abandoned) await repo.removeItem(stale.id);
      const data = await read();
      localRows.delete(row.id);
      if (data) apply(data);
    });
    return row.id;
  };

  /** An item from the add field: written first, then the row and the cleared field arrive together. */
  const addRow = async (text: string, depth: number) => {
    const id = crypto.randomUUID();
    const ordering = nextOrderingAfter(undefined);
    const abandoned = abandonedRows();
    lastCreatedDepth = depth;
    await repo.addItem(await ensureNote(), text, id, depth, ordering);
    for (const row of abandoned) await repo.removeItem(row.id);
    const data = await read();
    if (data) apply(data);
  };

  /** Adds the half-typed item from the add field. */
  const writeNew = async (text: string, depth: number) => {
    if (!text.trim()) return;
    const typed = text.trim();
    await addRow(typed, Math.min(depth, deepestDraftDepth()));
    // The submitted text is taken out of the field, in the same batch as the row appearing. Only
    // that prefix goes: the write is asynchronous, so the field may already hold the next item,
    // and dropping everything would make the caret's continuation repeat the item it created.
    batch(() => {
      const current = draft();
      if (current.trim() === typed) setDraft('');
      else if (current.startsWith(typed)) setDraft(current.slice(typed.length));
    });
    refocusAdd();
  };

  /**
   * A new item may be nested one level under the last row. The row this view just created counts
   * even before the reload carries it: Tab right after Enter must not be clamped by a stale list.
   */
  const deepestDraftDepth = () => {
    const last = all().at(-1)?.depth;
    const created = lastCreatedDepth === undefined ? undefined : lastCreatedDepth + 1;
    if (last === undefined) return created ?? 0;
    return Math.max(last + 1, created ?? 0);
  };

  const changeDraftDepth = (delta: number) => {
    setDraftDepth((depth) => Math.max(0, Math.min(depth + delta, deepestDraftDepth())));
  };

  /** Enter in the add field: an empty field steps the pending item out one level, like an item. */
  const enterDraft = () => {
    if (!draft().trim()) {
      changeDraftDepth(-1);
      return;
    }
    void flush();
  };

  // ---------------------------------------------------------------- row actions

  /** Through the same queue as the text writes: a check-off must not interleave with one. */
  const toggle = (id: string) =>
    void serial(async () => {
      const item = all().find((row) => row.id === id);
      if (!item) return;
      // Checking a parent off while its children are still open would hide them with it.
      if (item.done === 0 && descendants(item).some((child) => child.done === 0)) {
        warn(item);
        return;
      }
      try {
        await repo.toggleItem(id);
      } finally {
        await reconcile();
      }
    });

  const previousVisible = (item: Item): Item | undefined => {
    const list = visible();
    const index = list.findIndex((row) => row.id === item.id);
    return index > 0 ? list[index - 1] : undefined;
  };

  /** Backspace in an empty item removes it and puts the caret at the end of the item above. */
  const removeAndGoBack = async (item: Item) => {
    // The rows above this one, nearest first: a fast run of backspaces can remove two rows before
    // either write lands, so the caret cannot be pinned to one row that may be gone by then.
    const list = visible();
    const index = list.findIndex((row) => row.id === item.id);
    const above = (index > 0 ? list.slice(0, index) : []).map((row) => row.id).reverse();
    const previous = previousVisible(item);
    if (previous) focusItem(previous.id, true);
    try {
      await repo.removeItem(item.id);
    } finally {
      const data = await read();
      if (data) apply(data);
      // The caret above all else: the nearest row above that is still on screen, else the last row
      // there is, else the new-item field. It must never be left on the body.
      const alive = new Set(visible().map((row) => row.id));
      const target = above.find((id) => alive.has(id)) ?? visible().at(-1)?.id;
      if (target) focusItem(target, true);
      else addInput?.focus({ preventScroll: true });
    }
  };

  const onItemKeyDown = (item: Item, event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const text = pendingText(item.id);
      if (!text.trim()) {
        // Empty item: step out one level. Never commit here — an empty row stays a placeholder.
        if (item.depth > 0) void serial(() => setDepth(item.id, item.depth - 1));
        return;
      }
      // The caret moves before anything is written, so a keystroke that arrives at once has a
      // place to go: after the last row that place is the placeholder, elsewhere a blank row. A
      // row already on its way from the add field counts as after this one: the list on screen is
      // a write behind, and this row is not last if another is about to appear below it.
      const last = !queuedDraft && item.id === visible().at(-1)?.id;
      if (last) {
        setDraftDepth(item.depth);
        addInput?.focus({ preventScroll: true });
      } else {
        addBlankRow(item, item.depth);
      }
      void serial(() => writeText(item.id, text));
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const delta = event.shiftKey ? -1 : 1;
      void serial(async () => {
        // What is typed is written before the row is rebuilt for its new depth.
        await writeText(item.id, pendingText(item.id));
        await setDepth(item.id, item.depth + delta);
      });
    } else if (event.key === 'Backspace' && !pendingText(item.id)) {
      event.preventDefault();
      void serial(() => removeAndGoBack(item));
    }
  };

  return (
    <main class="page">
      <div class="card">
        <input
          ref={titleInput}
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
                    toggle(item.id);
                  }
                }}
              >
                <span class="bullet" aria-hidden="true" />
                <span class="item-body">
                  <input
                    class="item-text"
                    data-item={item.id}
                    aria-label={textOf(item) || 'empty item'}
                    value={textOf(item)}
                    ref={(el) => {
                      inputs.set(item.id, el);
                    }}
                    onInput={(e) => {
                      const value = e.currentTarget.value;
                      setEdits((current) => new Map(current).set(item.id, value));
                    }}
                    // Only a row with a pending edit is written: a row rebuilt by a reload blurs
                    // too, and must not be read as "emptied" and deleted.
                    onBlur={() => {
                      if (!edits().has(item.id)) return;
                      void serial(() => writeText(item.id, pendingText(item.id)));
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
            onBlur={() => void flush()}
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
        <span class="stamp muted small">{ago(updated(), now())}</span>
      </Show>
    </main>
  );
}
