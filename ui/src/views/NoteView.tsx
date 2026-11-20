import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import History from '../components/History';
import Editor, { type EditorApi } from '../editor/Editor';
import { useRepo } from '../db/context';
import { onCommand, onEditorFocus } from '../lib/commands';
import { registerFlush } from '../lib/flush';
import { signalViewReady } from '../lib/ready';


/**
 * The editor. With no `id` this is the landing draft: nothing exists in the database until
 * something has been written and saved.
 */
export default function NoteView(props: { id?: string; onCreated?: (id: string) => void }) {
  const repo = useRepo();
  const [noteId, setNoteId] = createSignal(props.id);
  const [body, setBody] = createSignal('');
  const [saved, setSaved] = createSignal('');
  const [historyOpen, setHistoryOpen] = createSignal(false);
  let editor: EditorApi | undefined;

  // Bumped on every keystroke: a load that resolves after the user started typing must not
  // overwrite what they wrote (the body it read is the older baseline, kept as `saved`).
  let edits = 0;
  // Bumped on every load: a slow load of a previous note must never apply its rows last.
  let generation = 0;
  // The note this editor created itself: its body is already on screen and newer than what a
  // read would return, so the follow-up load must not touch it.
  let ownNote: string | undefined;

  // Caret at the end and the page at the top; the editor itself grows with its content.
  const focusEnd = () => editor?.focusEnd();

  const load = async (id: string | undefined) => {
    const mine = ++generation;
    const mark = edits;
    setNoteId(id);
    setHistoryOpen(false);
    if (id && id === ownNote) {
      ownNote = undefined;
      return;
    }
    if (!id) {
      setBody('');
      setSaved('');
      requestAnimationFrame(() => {
        focusEnd();
        signalViewReady();
      });
      return;
    }
    const note = await repo.getNote(id);
    if (mine !== generation) return;
    setSaved(note?.body ?? '');
    if (edits === mark) setBody(note?.body ?? '');
    // Focus and signal in the same frame, so a caller waiting for "ready" never sees the old state.
    requestAnimationFrame(() => {
      if (mine !== generation) return;
      focusEnd();
      signalViewReady();
    });
  };

  createEffect(() => void load(props.id));

  // Saves are serialised and their state is captured synchronously, so a flush can be started
  // right before the editor is reset without picking up the new, empty editor.
  let queue: Promise<void> = Promise.resolve();
  // The note a queued flush of this draft created, so a second queued flush saves into it
  // instead of creating another note. Scoped by load generation: a fresh draft never reuses it.
  let draftNote: { id: string; gen: number } | undefined;

  const flush = (): Promise<void> => {
    const snapshot = {
      text: body(),
      startId: noteId(),
      // What was on screen at capture time. A save requested before the note finished loading
      // then cannot be mistaken for an edit down to an empty document.
      baseline: saved(),
      gen: generation,
    };
    queue = queue.then(() => save(snapshot)).catch((err) => console.error('save failed', err));
    return queue;
  };

  const save = async (snapshot: { text: string; startId: string | undefined; baseline: string; gen: number }) => {
    const { text, startId, baseline, gen } = snapshot;
    // A draft is only materialised once it has content; an unchanged body is not written again.
    if (!startId && !text.trim()) return;
    if (text === baseline) {
      // The editor is clean, so this flush must not turn a pulled version into a local write.
      // Take what the database now says instead of re-committing the text we were showing.
      const note = startId ? await repo.getNote(startId) : undefined;
      if (note && note.body !== baseline) {
        setSaved(note.body);
        if (generation === gen && body() === baseline) setBody(note.body);
      }
      return;
    }
    const mine = () => generation === gen; // false once the editor moved on
    const reused = !startId && draftNote?.gen === gen ? draftNote.id : undefined;
    const created = !startId && !reused;
    const id = startId ?? reused ?? (await repo.createNote('note'));
    if (created) draftNote = { id, gen };

    await repo.saveBody(id, text);
    if (mine()) {
      setSaved(text);
    }
    if (created && mine()) {
      setNoteId(id);
      ownNote = id;
      props.onCreated?.(id);
    }
  };

  const openHistory = async () => {
    await flush(); // a draft gets its id here
    setHistoryOpen(!historyOpen());
  };

  onMount(() => {
    focusEnd();
    const off = [
      registerFlush(flush),
      onEditorFocus(focusEnd),
      onCommand('save', () => void flush()),
      onCommand('history', () => void openHistory()),
    ];
    onCleanup(() => off.forEach((unregister) => unregister()));
  });

  return (
    <main class="page">
      <Editor
        docKey={noteId() ?? 'draft'}
        ariaLabel="note body"
        placeholder="Write something nice"
        value={body()}
        onInput={(text) => {
          edits += 1;
          setBody(text);
        }}
        onBlur={() => void flush()}
        onReady={(api) => {
          editor = api;
        }}
      />
      <Show when={historyOpen() && noteId()}>
        <History noteId={noteId()!} onClose={() => setHistoryOpen(false)} />
      </Show>
    </main>
  );
}
