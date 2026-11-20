import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import HistoryHost from './components/History';
import Sync from './components/Sync';
import { useRepo } from './db/context';
import { focusEditor, onCommand } from './lib/commands';
import { flushAll } from './lib/flush';
import { armViewReady } from './lib/ready';
import { createEngine } from './sync/engine';
import { SyncProvider } from './sync/context';
import { idbAccount } from './sync/keystore';
import NoteList from './views/NoteList';
import NoteView from './views/NoteView';
import TodoView from './views/TodoView';

type Open = { kind: 'note'; id?: string } | { kind: 'todo'; id?: string };

/** One page, no routes: the landing state is an empty note that is only saved once written. */
export default function App() {
  const repo = useRepo();
  // Deep links are paths (/note/<id>): the host must serve index.html for them (an spa fallback).
  const linkedId = location.pathname.match(/\/note\/([\w-]+)/)?.[1] ?? null;
  const engine = createEngine({ repo, store: idbAccount });
  const [open, setOpen] = createSignal<Open>({ kind: 'note' });
  const [syncOpen, setSyncOpen] = createSignal(false);
  const [linked, setLinked] = createSignal(linkedId === null);
  const [listOpen, setListOpen] = createSignal(false);

  // The open note is in the url, so a reload or a bookmark lands on the same note.
  createEffect(() => {
    const id = open().id;
    if (!id && !linked()) return; // the note in the url is still being looked up
    const url = new URL(location.href);
    url.pathname = id ? `${import.meta.env.BASE_URL}note/${id}` : import.meta.env.BASE_URL;
    history.replaceState(null, '', url);
  });

  onMount(() => {
    engine.start();
    onCleanup(() => engine.stop());
    void (async () => {
      const note = linkedId ? await repo.getNote(linkedId) : undefined;
      if (note) setOpen({ kind: note.kind, id: note.id });
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

  return (
    <SyncProvider engine={engine}>
      <Show
        when={open().kind === 'note'}
        fallback={<TodoView id={open().id} onCreated={(id) => setOpen({ kind: 'todo', id })} />}
      >
        <NoteView id={open().id} onCreated={(id) => setOpen({ kind: 'note', id })} />
      </Show>
      <Show when={listOpen()}>
        <NoteList
          currentId={open().id}
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
            setOpen({ kind: note.kind, id: note.id });
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
    </SyncProvider>
  );
}
