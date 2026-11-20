import { createEffect, createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import HistoryHost from './components/History';
import MobileBar from './components/MobileBar';
import Sync from './components/Sync';
import SyncDot from './components/SyncDot';
import type { Note } from './db/api';
import { useRepo } from './db/context';
import { formatBoard, isDashboard } from './lib/board';
import { focusEditor, onCommand } from './lib/commands';
import { flushAll } from './lib/flush';
import { armViewReady } from './lib/ready';
import { createEngine } from './sync/engine';
import { SyncProvider } from './sync/context';
import { idbAccount } from './sync/keystore';
import Dashboard from './views/Dashboard';
import TagView from './views/TagView';
import NoteList from './views/NoteList';
import NoteView from './views/NoteView';
import TodoView from './views/TodoView';

// `tag` is not a note kind: it is a stream over the notes carrying a tag, so it has no id.
type Open = { kind: 'note' | 'todo' | 'dashboard' | 'tag'; id?: string; tag?: string };

/** A board is a note that says so in its body: no note type of its own (design/002). */
const kindOf = (note: Note): Open['kind'] =>
  note.kind === 'todo' ? 'todo' : isDashboard(note.body) ? 'dashboard' : 'note';

/** One page, no routes: the landing state is an empty note that is only saved once written. */
export default function App() {
  const repo = useRepo();
  // Deep links are paths (/note/<id>): the host must serve index.html for them (an spa fallback).
  const linkedId = location.pathname.match(/\/note\/([\w-]+)/)?.[1] ?? null;
  const linkedTag = location.pathname.match(/\/tag\/([^/?#]+)/)?.[1] ?? null;
  const engine = createEngine({ repo, store: idbAccount });
  const [open, setOpen] = createSignal<Open>({ kind: 'note' });
  const [syncOpen, setSyncOpen] = createSignal(false);
  const [linked, setLinked] = createSignal(linkedId === null && linkedTag === null);
  const [listOpen, setListOpen] = createSignal(false);

  // The open view is in the url, so a reload or a bookmark lands on the same place.
  createEffect(() => {
    const current = open();
    const base = import.meta.env.BASE_URL;
    if (!current.id && !current.tag && !linked()) return; // the url is still being looked up
    const path = current.tag ? `${base}tag/${current.tag}` : current.id ? `${base}note/${current.id}` : base;
    const url = new URL(location.href);
    if (url.pathname === path) return;
    url.pathname = path;
    history.replaceState(null, '', url);
  });

  onMount(() => {
    engine.start();
    onCleanup(() => engine.stop());
    // A phone suspends the app without ever blurring the editor, and without a server there is
    // no hidden-tab sync to flush it: save on the way out.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void flushAll(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    onCleanup(() => document.removeEventListener('visibilitychange', onVisibility));
    void (async () => {
      const note = linkedId ? await repo.getNote(linkedId) : undefined;
      if (note) setOpen({ kind: kindOf(note), id: note.id });
      else if (linkedTag) setOpen({ kind: 'tag', tag: decodeURIComponent(linkedTag) });
      setLinked(true); // a url naming a deleted or unknown note falls back to the draft
    })();

    const off = [
      onCommand('list', async () => {
        if (listOpen()) {
          setListOpen(false);
          focusEditor();
          return;
        }
        await flushAll();
        setListOpen(true);
      }),
      onCommand('new-note', async () => {
        // Reset immediately, save the previous note in the background: the flush took its
        // snapshot synchronously, so typing into the new draft cannot be swallowed.
        const pending = flushAll();
        setListOpen(false);
        setOpen({ kind: 'note' });
        await pending;
        focusEditor();
      }),
      onCommand('new-list', async () => {
        await flushAll();
        setListOpen(false);
        setOpen({ kind: 'todo' }); // a draft: no row until an item or a title is written
      }),
      onCommand('new-dashboard', async () => {
        await flushAll();
        setListOpen(false);
        // No draft: a board has no editor to give a first keystroke to, so it exists at once.
        const id = await repo.createNote('note');
        await repo.saveBody(id, formatBoard({ title: 'Board', tiles: [] }));
        setOpen({ kind: 'dashboard', id });
      }),
      onCommand('sync', async () => {
        setListOpen(false);
        setSyncOpen(true);
      }),
      onCommand('delete', async () => {
        // Flush first: a draft just saved by ⌘S only has an id once its flush finished.
        await flushAll();
        const current = open();
        if (!current.id) return;
        await repo.setNoteMeta(current.id, { deleted: true });
        setListOpen(false);
        setOpen({ kind: 'note' });
      }),
    ];
    onCleanup(() => off.forEach((unregister) => unregister()));
  });

  const openTag = async (tag: string) => {
    await flushAll(); // the note being left is saved before its tag stream is built
    setListOpen(false);
    setOpen({ kind: 'tag', tag });
  };

  return (
    <SyncProvider engine={engine}>
      <Switch>
        <Match when={open().kind === 'dashboard'}>
          <Dashboard id={open().id ?? ''} onOpen={(note) => setOpen({ kind: kindOf(note), id: note.id })} />
        </Match>
        <Match when={open().kind === 'tag'}>
          <TagView tag={open().tag ?? ''} onOpen={(note) => setOpen({ kind: kindOf(note), id: note.id })} />
        </Match>
        <Match when={open().kind === 'todo'}>
          <TodoView id={open().id} onCreated={(id) => setOpen({ kind: 'todo', id })} />
        </Match>
        <Match when={true}>
          <NoteView id={open().id} onCreated={(id) => setOpen({ kind: 'note', id })} />
        </Match>
      </Switch>
      <Show when={listOpen()}>
        <NoteList
          currentId={open().id}
          onTag={(tag) => void openTag(tag)}
          onClose={() => {
            setListOpen(false);
            focusEditor();
          }}
          onOpen={async (note) => {
            const current = open();
            if (current.id === note.id) {
              // Already there: nothing to load, so no handshake to wait for.
              setListOpen(false);
              focusEditor();
              return;
            }
            await flushAll();
            const ready = armViewReady();
            setOpen({ kind: kindOf(note), id: note.id });
            // Close the overlay on a loaded view, not on the previous note's text.
            await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 150))]);
            setListOpen(false);
            focusEditor();
          }}
        />
      </Show>
      <Show when={syncOpen()}>
        <Sync onClose={() => setSyncOpen(false)} />
      </Show>
      <MobileBar kind={open().kind} />
      <SyncDot />
    </SyncProvider>
  );
}
