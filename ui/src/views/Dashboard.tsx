import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { Note } from '../db/api';
import { useRepo } from '../db/context';
import { formatBoard, isDashboard, moved, parseBoard, resized, withTile, withoutTile, type Board, type Tile } from '../lib/board';
import { onEditorFocus } from '../lib/commands';
import { flushAll, registerFlush } from '../lib/flush';
import { signalViewReady } from '../lib/ready';
import NoteList from './NoteList';
import NoteView from './NoteView';
import TodoView from './TodoView';

/**
 * A dashboard: notes and lists as tiles over the whole viewport, read and written in place. The
 * board itself is an ordinary note — its body holds the layout (lib/board.ts) — so the tiles are
 * the very same views a note or a list opens in, one flag narrower (design/002, design/004).
 */
export default function Dashboard(props: { id: string; onOpen?: (note: Note) => void }) {
  const repo = useRepo();
  const [board, setBoard] = createSignal<Board>({ title: '', tiles: [] });
  const [title, setTitle] = createSignal('');
  const [picking, setPicking] = createSignal(false);
  // What is on disk for this board, so its own write coming back is not mistaken for a remote one.
  let saved = '';
  let focused: HTMLElement | undefined;
  let ready = false;

  // Every layout action is one small snapshot: a click, not a keystroke, so there is nothing to debounce.
  const commit = (next: Board) => {
    const fixed = { ...next, title: next.title.trim() || 'Board' }; // the heading is the note's title
    setBoard(fixed);
    setTitle(fixed.title);
    saved = formatBoard(fixed);
    return repo.saveBody(props.id, saved);
  };

  // The title is the one thing typed rather than clicked, so it is committed by a flush: ⌘S, a sync,
  // the tab going away or a command leaving the view. Without this, a keyboard command out of the
  // title input unmounts the view with no blur and the note's name is lost.
  const commitTitle = () => {
    const typed = title().trim();
    if (!typed || typed === board().title) return;
    return commit({ ...board(), title: typed });
  };

  const reload = async () => {
    const note = await repo.getNote(props.id);
    const body = note?.body ?? '';
    if (body !== saved) {
      saved = body;
      const loaded = parseBoard(body);
      setBoard(loaded);
      setTitle(loaded.title);
    }
    if (!ready) {
      ready = true;
      signalViewReady();
    }
  };

  createEffect(() => {
    void props.id;
    saved = '';
    ready = false;
    void reload();
  });

  onMount(() => {
    const stop = repo.onChange?.(() => void reload());
    const offFlush = registerFlush(() => commitTitle());
    // An overlay closed: the caret goes back to the field it left, never to an arbitrary tile.
    const off = onEditorFocus(() => {
      if (focused?.isConnected) focused.focus();
    });
    onCleanup(() => {
      stop?.();
      off();
      offFlush();
    });
  });

  return (
    <main
      class="board"
      ref={(el) => el.addEventListener('focusin', (event) => (focused = event.target as HTMLElement))}
    >
      <header class="board-head">
        <input
          class="title"
          aria-label="board title"
          placeholder="Untitled board"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          onBlur={() => commit({ ...board(), title: title() })}
        />
        <button type="button" class="board-add" onClick={() => setPicking(true)}>
          add note
        </button>
      </header>

      <div class="board-grid">
        <For each={board().tiles}>
          {(tile, index) => (
            <Tile
              tile={tile}
              onOpen={(note) => props.onOpen?.(note)}
              onMove={(delta) => commit(moved(board(), index(), delta))}
              onSize={(patch) => commit(resized(board(), index(), patch))}
              onRemove={() => commit(withoutTile(board(), tile.note))}
            />
          )}
        </For>
      </div>

      <Show when={!board().tiles.length}>
        <p class="muted board-empty">
          Add a note or a list. Each one stays its own note; this board only points at it.
        </p>
      </Show>

      <Show when={picking()}>
        <NoteList
          exclude={(note) => isDashboard(note.body)}
          onOpen={(note) => {
            setPicking(false);
            commit(withTile(board(), note.id));
          }}
          onClose={() => setPicking(false)}
        />
      </Show>
    </main>
  );
}

/** One tile: the note it points at, its own controls, and the ordinary view inside. */
function Tile(props: {
  tile: Tile;
  onOpen: (note: Note) => void;
  onMove: (delta: number) => void;
  onSize: (patch: { w?: number; h?: number }) => void;
  onRemove: () => void;
}) {
  const repo = useRepo();
  const [note] = createResource(() => props.tile.note, (id) => repo.getNote(id));

  // A plain click stays in the app; a modified one is the browser's to open in a new tab.
  const open = (event: MouseEvent) => {
    const found = note();
    if (!found || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void (async () => {
      // A tile unmounting under the caret must still save what was typed into it before the
      // fullscreen view reads the body.
      await flushAll();
      props.onOpen(found);
    })();
  };

  const body = () => {
    const found = note();
    if (!found) return <p class="muted">loading…</p>;
    if (found.deleted) return <p class="muted">This note was deleted.</p>;
    if (isDashboard(found.body)) return <p class="muted">A dashboard cannot hold another.</p>;
    if (found.kind === 'todo') return <TodoView embedded id={found.id} />;
    return <NoteView embedded id={found.id} />;
  };

  return (
    <article class={`tile w${props.tile.w} h${props.tile.h}`}>
      <div class="tile-controls">
        <a
          class="tile-open"
          href={`${import.meta.env.BASE_URL}note/${props.tile.note}`}
          aria-label="open note"
          onClick={open}
        >
          ↗
        </a>
        <button type="button" aria-label="move tile up" onClick={() => props.onMove(-1)}>
          ↑
        </button>
        <button type="button" aria-label="move tile down" onClick={() => props.onMove(1)}>
          ↓
        </button>
        <button type="button" aria-label="tile width" onClick={() => props.onSize({ w: (props.tile.w % 3) + 1 })}>
          ↔{props.tile.w}
        </button>
        <button type="button" aria-label="tile height" onClick={() => props.onSize({ h: (props.tile.h % 3) + 1 })}>
          ↕{props.tile.h}
        </button>
        <button type="button" aria-label="remove from board" onClick={() => props.onRemove()}>
          ×
        </button>
      </div>
      <div class="tile-body">{body()}</div>
    </article>
  );
}
