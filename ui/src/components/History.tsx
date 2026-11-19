import { createResource, For, Show } from 'solid-js';
import { useRepo } from '../db/context';
import { ago } from '../lib/time';

const preview = (body: string) => {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > 70 ? `${flat.slice(0, 70)}…` : flat || '(empty)';
};

export default function History(props: { noteId: string; onRestore?: () => void }) {
  const repo = useRepo();
  const [versions, { refetch }] = createResource(() => props.noteId, (id) => repo.versions(id));
  const [heads] = createResource(() => props.noteId, (id) => repo.heads(id));

  const restore = async (versionId: string) => {
    await repo.restoreVersion(props.noteId, versionId);
    void refetch();
    props.onRestore?.();
  };

  return (
    <section class="history">
      <Show when={(heads() ?? []).length > 1}>
        <p class="warn">{(heads() ?? []).length} branches from other devices — nothing was merged</p>
      </Show>
      <For each={versions() ?? []} fallback={<p class="muted">no versions yet</p>}>
        {(version) => (
          <div class="version">
            <span class="muted">{ago(version.created)}</span>
            <span class="preview">{preview(version.body)}</span>
            <button type="button" onClick={() => void restore(version.id)}>
              restore
            </button>
          </div>
        )}
      </For>
    </section>
  );
}
