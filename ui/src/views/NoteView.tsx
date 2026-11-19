import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import History from '../components/History';
import { useRepo } from '../db/context';
import { onCommand, onEditorFocus } from '../lib/commands';
import { registerFlush } from '../lib/flush';
import { ago } from '../lib/time';

/**
 * The editor. With no `id` this is the landing draft: nothing exists in the database until
 * something has been written and saved.
 */
export default function NoteView(props: { id?: string; onCreated?: (id: string) => void }) {
  const repo = useRepo();
  const [noteId, setNoteId] = createSignal(props.id);
  const [body, setBody] = createSignal('');
  const [saved, setSaved] = createSignal('');
  const [tags, setTags] = createSignal('');
  const [savedTags, setSavedTags] = createSignal('');
  const [updated, setUpdated] = createSignal(0);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  let editor: HTMLTextAreaElement | undefined;

  // Bumped on every keystroke: a load that resolves after the user started typing must not
  // overwrite what they wrote (the body it read is the older baseline, kept as `saved`).
  let edits = 0;
  // Bumped on every load: a slow load of a previous note must never apply its rows last.
  let generation = 0;
  // The note this editor created itself: its body is already on screen and newer than what a
  // read would return, so the follow-up load must not touch it.
  let ownNote: string | undefined;

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
      setTags('');
      setSavedTags('');
      setUpdated(0);
      return;
    }
    const note = await repo.getNote(id);
    const noteTags = await repo.tagsOf(id);
    if (mine !== generation) return;
    setSaved(note?.body ?? '');
    if (edits === mark) setBody(note?.body ?? '');
    setTags(noteTags.join(', '));
    setSavedTags(noteTags.join(', '));
    setUpdated(note?.updated ?? 0);
  };

  createEffect(() => void load(props.id));

  // One flush at a time: two overlapping flushes of a draft would both see "no note yet"
  // and create two notes.
  let inFlight: Promise<void> | null = null;

  const flush = async (): Promise<void> => {
    while (inFlight) await inFlight;
    inFlight = doFlush().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const doFlush = async () => {
    const text = body();
    const tagList = tags()
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    let id = noteId();
    // A draft is only materialised once it has content.
    if (!id && !text.trim() && tagList.length === 0) return;
    let created = false;
    if (!id) {
      id = await repo.createNote('note');
      setNoteId(id);
      created = true;
    }
    if (text !== saved()) {
      await repo.saveBody(id, text);
      setSaved(text);
      setUpdated(Date.now());
    }
    if (tagList.join(',') !== savedTags().split(',').filter(Boolean).join(',')) {
      await repo.setNoteMeta(id, { tags: tagList });
      setSavedTags(tagList.join(', '));
    }
    // Only now can the parent switch to this note: it must not load a note whose body
    // has not been written yet, or the load would clear the editor.
    if (created) {
      ownNote = id;
      editor?.focus();
      props.onCreated?.(id);
    }
  };

  onMount(() => {
    editor?.focus();
    const off = [
      registerFlush(flush),
      onEditorFocus(() => editor?.focus()),
      onCommand('save', () => void flush()),
      onCommand('history', async () => {
        await flush(); // a draft gets its id here
        setHistoryOpen(!historyOpen());
      }),
    ];
    onCleanup(() => off.forEach((unregister) => unregister()));
  });

  return (
    <main class="page">
      <textarea
        ref={editor}
        class="editor"
        aria-label="note body"
        placeholder=""
        value={body()}
        onInput={(e) => {
          edits += 1;
          setBody(e.currentTarget.value);
        }}
        onBlur={() => void flush()}
      />
      <div class="meta">
        <input
          class="tags"
          aria-label="tags"
          placeholder="tags"
          value={tags()}
          onInput={(e) => setTags(e.currentTarget.value)}
          onBlur={() => void flush()}
        />
        <Show when={updated()}>
          <span class="muted small">{ago(updated())}</span>
        </Show>
      </div>
      <Show when={historyOpen() && noteId()}>
        <History noteId={noteId()!} onClose={() => setHistoryOpen(false)} onRestore={() => void load(noteId())} />
      </Show>
    </main>
  );
}
