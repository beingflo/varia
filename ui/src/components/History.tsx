import { createResource, For, onCleanup, onMount, Show } from 'solid-js';
import { useRepo } from '../db/context';
import { ago } from '../lib/time';

const preview = (body: string) => {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat || '(empty)';
};

/** The version tree of one note, as a fullscreen list: Escape closes, clicking a version restores it. */
export default function History(props: { noteId: string; onClose: () => void; onRestore?: () => void }) {
  const repo = useRepo();
  const [versions, { refetch }] = createResource(() => props.noteId, (id) => repo.versions(id));
  const [heads] = createResource(() => props.noteId, (id) => repo.heads(id));

  const restore = async (versionId: string) => {
    await repo.restoreVersion(props.noteId, versionId);
    void refetch();
    props.onRestore?.();
    props.onClose();
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  return (
    <section class="overlay" aria-label="history">
      <p class="muted small">
        versions of this note, newest first — click one to restore it
        <Show when={(heads() ?? []).length > 1}> · {(heads() ?? []).length} branches from other devices</Show>
      </p>
      <For each={versions() ?? []} fallback={<p class="muted">no versions yet</p>}>
        {(version) => (
          <div class="version" onClick={() => void restore(version.id)}>
            <span class="muted small">{ago(version.created)}</span>
            <span class="preview">{preview(version.body)}</span>
          </div>
        )}
      </For>
    </section>
  );
}
