import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import HistoryHost from './components/History';
import { useRepo } from './db/context';
import { focusEditor, onCommand } from './lib/commands';
import { flushAll } from './lib/flush';
import { armViewReady } from './lib/ready';
import NoteList from './views/NoteList';
import NoteView from './views/NoteView';
import TodoView from './views/TodoView';

type Open = { kind: 'note'; id?: string } | { kind: 'todo'; id: string };

/** One page, no routes: the landing state is an empty note that is only saved once written. */
export default function App() {
  const repo = useRepo();
  const [open, setOpen] = createSignal<Open>({ kind: 'note' });
  const [listOpen, setListOpen] = createSignal(false);

  onMount(() => {
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
        setOpen({ kind: 'todo', id: await repo.createNote('todo') });
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
    <>
      <Show when={open().kind === 'note'} fallback={<TodoView id={(open() as { id: string }).id} />}>
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
    </>
  );
}
