import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { useRepo } from '../db/context';
import type { ImportedNote } from '../db/types';
import { parseImportFile } from '../lib/import';

const EXAMPLE = `{
  "count": 1,
  "notes": [
    {
      "oldId": 1075,
      "createdAt": "2026-11-20T21:52:22.982216+00:00",
      "modifiedAt": "2026-11-20T21:52:22.982216+00:00",
      "body": "## Varia test sync token\\n\\n14c3b821…"
    }
  ]
}`;

/** The one-off fieldnotes migration: pick the converted file, confirm, done. */
export default function Import(props: { onClose: () => void }) {
  const repo = useRepo();
  const [notes, setNotes] = createSignal<ImportedNote[]>();
  const [filename, setFilename] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal(0);

  const pick = async (input: HTMLInputElement) => {
    setNotes(undefined);
    setError('');
    setDone(0);
    const file = input.files?.[0];
    setFilename(file?.name ?? '');
    if (!file) return;
    try {
      setNotes(parseImportFile(await file.text()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const run = async () => {
    const list = notes();
    if (!list || busy()) return;
    setBusy(true);
    setError('');
    try {
      setDone(await repo.importNotes(list));
      setNotes(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => window.removeEventListener('keydown', onKey, true));
  });

  return (
    <section class="overlay form" aria-label="import">
      <button type="button" class="overlay-close" onClick={props.onClose}>
        close
      </button>
      <p class="small">
        Import notes from a JSON file. This is the one-off fieldnotes migration: pick what{' '}
        <code>convert-notes.mjs</code> wrote. Nothing is written until you confirm.
      </p>
      <p class="muted small">the file must hold one entry per note:</p>
      <pre class="code">{EXAMPLE}</pre>
      <p class="muted small">
        <code>oldId</code> is the old note's id and becomes this note's id, so the same file can never be
        imported twice. <code>createdAt</code> and <code>modifiedAt</code> are kept as the
        note's dates, and <code>body</code> is the note as Markdown, title line included.
      </p>
      <input
        type="file"
        accept=".json,application/json"
        aria-label="import file"
        onChange={(e) => void pick(e.currentTarget)}
      />
      <Show when={filename()}>
        <p class="small muted">{filename()}</p>
      </Show>
      <Show when={notes()}>{(list) => <p class="small">format ok — {list().length} notes ready to import</p>}</Show>
      <Show when={error()}>
        <p class="small warn">{error()}</p>
      </Show>
      <Show when={done()}>
        <p class="small">{done()} notes imported. Close this screen; they sync like any other note.</p>
      </Show>
      <button type="button" class="action primary" disabled={!notes() || busy()} onClick={() => void run()}>
        {notes() ? `import ${notes()!.length} notes` : 'import'}
      </button>
    </section>
  );
}
