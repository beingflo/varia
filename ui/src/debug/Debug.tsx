// Debug overlay: read-only views of the local database. Loaded on demand, mounted in a shadow root,
// wrapped in an ErrorBoundary by its mounter. Nothing here is imported by the app proper.
import { createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import type { Repo } from '../db/api';

const PAGE = 100;

export default function Debug(props: { repo: Repo; onClose: () => void }) {
  const [table, setTable] = createSignal('note');
  const [offset, setOffset] = createSignal(0);
  const [selected, setSelected] = createSignal<Record<string, unknown> | null>(null);

  const [tables, { refetch: refetchTables }] = createResource(() => props.repo.debugTables());
  const [page, { refetch: refetchPage }] = createResource(
    () => ({ table: table(), offset: offset() }),
    (key) => props.repo.debugRows(key.table, key.offset, PAGE),
  );

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
  };
  window.addEventListener('keydown', onKey);
  onCleanup(() => window.removeEventListener('keydown', onKey));

  const pick = (name: string) => {
    setTable(name);
    setOffset(0);
    setSelected(null);
  };

  const refresh = () => {
    void refetchTables();
    void refetchPage();
  };

  // A failed resource re-throws when read; a debugging tool must never do that, so every
  // read goes through these guards and errors are shown as text.
  const failed = () => Boolean(page.error);
  const rows = () => (failed() ? [] : (page()?.rows ?? []));
  const columns = () => (failed() ? [] : (page()?.columns ?? []));
  const total = () => (failed() ? 0 : (page()?.total ?? 0));

  return (
    <div class="panel">
      <header>
        <span class="name">varia · database</span>
        <button type="button" onClick={refresh}>
          refresh
        </button>
        <span class="hint">⌘/ctrl+shift+d or esc to close</span>
        <button type="button" onClick={props.onClose}>
          close
        </button>
      </header>

      <div class="body">
        <nav>
          <For each={tables() ?? []}>
            {(t) => (
              <button
                type="button"
                aria-label={`table ${t.name}`}
                class={t.name === table() ? 'on' : ''}
                onClick={() => pick(t.name)}
              >
                <span>{t.name}</span>
                <span class="count">{t.count}</span>
              </button>
            )}
          </For>
          <Show when={tables.error}>
            {(err) => <p class="error">{String((err() as Error)?.message ?? err())}</p>}
          </Show>
        </nav>

        <main>
          <div class="toolbar">
            <span class="muted">{table()}</span>
            <span class="muted">
              {total() === 0 ? 'no rows' : `${offset() + 1}–${Math.min(offset() + PAGE, total())} of ${total()}`}
            </span>
            <button type="button" disabled={offset() === 0} onClick={() => setOffset(Math.max(0, offset() - PAGE))}>
              prev
            </button>
            <button
              type="button"
              disabled={offset() + PAGE >= total()}
              onClick={() => setOffset(offset() + PAGE)}
            >
              next
            </button>
          </div>

          <Show when={page.error}>
            {(err) => <p class="error">query failed: {String((err() as Error)?.message ?? err())}</p>}
          </Show>

          <div class="scroll">
            <Show when={rows().length > 0} fallback={<p class="empty">{failed() ? ' ' : 'no rows'}</p>}>
              <table>
                <thead>
                  <tr>
                    <For each={columns()}>{(column) => <th>{column}</th>}</For>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows()}>
                    {(row) => (
                      <tr
                        class={selected() === row ? 'on' : ''}
                        onClick={() => setSelected(selected() === row ? null : row)}
                      >
                        <For each={columns()}>
                          {(column) => {
                            const value = row[column];
                            return (
                              <td
                                class={value === null ? 'null' : typeof value === 'number' ? 'num' : ''}
                                title={value === null ? 'null' : String(value)}
                              >
                                {value === null ? 'null' : String(value)}
                              </td>
                            );
                          }}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>

          <Show when={selected()}>
            {(row) => (
              <div class="detail">
                <pre>{JSON.stringify(row(), null, 2)}</pre>
              </div>
            )}
          </Show>
        </main>
      </div>
    </div>
  );
}
