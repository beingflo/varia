import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import History from '../components/History';
import { useRepo } from '../db/context';
import { onCommand, onEditorFocus } from '../lib/commands';
import { registerFlush } from '../lib/flush';
import { signalViewReady } from '../lib/ready';
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

  // Caret at the end, page at the top: focusing a long note must not scroll it into view.
  const focusEnd = () => {
    const el = editor;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  };

  // The editor grows with its content; the page scrolls, never the field.
  const autosize = () => {
    const el = editor;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

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
      requestAnimationFrame(() => {
        autosize(); // a fresh draft starts at its initial height again
        focusEnd();
        window.scrollTo({ top: 0 });
        signalViewReady();
      });
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
    // Size and signal in the same frame, so a caller waiting for "ready" never sees the old height.
    requestAnimationFrame(() => {
      if (mine !== generation) return;
      autosize();
      focusEnd();
      window.scrollTo({ top: 0 });
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
      tags: tags()
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      gen: generation,
    };
    queue = queue.then(() => save(snapshot)).catch((err) => console.error('save failed', err));
    return queue;
  };

  const save = async (snapshot: { text: string; startId: string | undefined; tags: string[]; gen: number }) => {
    const { text, startId, tags: tagList, gen } = snapshot;
    // A draft is only materialised once it has content.
    if (!startId && !text.trim() && tagList.length === 0) return;
    const mine = () => generation === gen; // false once the editor moved on
    const reused = !startId && draftNote?.gen === gen ? draftNote.id : undefined;
    const created = !startId && !reused;
    const id = startId ?? reused ?? (await repo.createNote('note'));
    if (created) draftNote = { id, gen };

    if (text !== saved()) {
      await repo.saveBody(id, text);
      if (mine()) {
        setSaved(text);
        setUpdated(Date.now());
      }
    }
    if (tagList.join(',') !== savedTags().split(',').filter(Boolean).join(',')) {
      await repo.setNoteMeta(id, { tags: tagList });
      if (mine()) setSavedTags(tagList.join(', '));
    }
    if (created && mine()) {
      setNoteId(id);
      ownNote = id;
      props.onCreated?.(id);
    }
  };

  onMount(() => {
    focusEnd();
    autosize();
    window.addEventListener('resize', autosize);
    const off = [
      registerFlush(flush),
      onEditorFocus(focusEnd),
      onCommand('save', () => void flush()),
      onCommand('history', async () => {
        await flush(); // a draft gets its id here
        setHistoryOpen(!historyOpen());
      }),
    ];
    onCleanup(() => {
      off.forEach((unregister) => unregister());
      window.removeEventListener('resize', autosize);
    });
  });

  return (
    <main class="page">
      <textarea
        ref={editor}
        class="editor"
        aria-label="note body"
        placeholder="Write something nice"
        value={body()}
        onInput={(e) => {
          edits += 1;
          setBody(e.currentTarget.value);
          autosize();
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
      </div>

      <Show when={updated()}>
        <span class="stamp muted small">{ago(updated())}</span>
      </Show>
      <Show when={historyOpen() && noteId()}>
        <History noteId={noteId()!} onClose={() => setHistoryOpen(false)} onRestore={() => void load(noteId())} />
      </Show>
    </main>
  );
}
