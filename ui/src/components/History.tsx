import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { useRepo } from '../db/context';
import type { VersionMeta } from '../db/types';
import { ago } from '../lib/time';
import { shortId } from '../lib/versions';
import { versionTree } from '../lib/versionTree';

/** Row height and lane width in px: the graph is drawn from the same numbers the rows use. */
const ROW = 30;
const LANE = 22;

/**
 * The version tree of one note (design/002): one parent, many children, never a merge. This screen
 * only reads: the selected version's body is shown beside the tree, and nothing here writes.
 */
export default function History(props: { noteId: string; onClose: () => void }) {
  const repo = useRepo();
  const [versions] = createResource(() => props.noteId, (id) => repo.versions(id));
  const tree = createMemo(() => versionTree(versions() ?? []));

  const [picked, setPicked] = createSignal<string | null>(null);
  const selected = createMemo<VersionMeta | undefined>(() => {
    const rows = tree().rows;
    return rows.find((row) => row.id === picked()) ?? rows[0];
  });
  const current = createMemo(() => tree().rows.find((row) => row.current)?.id);
  const isCurrent = () => selected()?.id === current();
  /** Bodies are fetched per version: opening history does not ship the note's whole history. */
  const [body] = createResource(() => selected()?.id, (id) => repo.versionBody(props.noteId, id));

  let list: HTMLDivElement | undefined;

  // The selection must be visible when it moves past the fold.
  createEffect(() => {
    const id = selected()?.id;
    if (!id) return;
    // jsdom has no scrollIntoView; the test suite renders this overlay too.
    (list?.querySelector(`#v-${id}`) as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  });

  onMount(() => {
    list?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        props.onClose();
        return;
      }
      const rows = tree().rows;
      if (!rows.length) return;
      const at = Math.max(0, rows.findIndex((row) => row.id === selected()?.id));
      const move = (to: number) => {
        event.preventDefault();
        setPicked(rows[Math.min(Math.max(to, 0), rows.length - 1)].id);
      };
      if (event.key === 'ArrowDown' || event.key === 'j') move(at + 1);
      else if (event.key === 'ArrowUp' || event.key === 'k') move(at - 1);
      else if (event.key === 'Home') move(0);
      else if (event.key === 'End') move(rows.length - 1);
    };
    list?.addEventListener('keydown', onKey);
    // Escape must work before the list has focus, e.g. right after a click on the header.
    const onWindowKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onWindowKey);
    onCleanup(() => {
      list?.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onWindowKey);
    });
  });

  return (
    <section class="overlay history" aria-label="history">
      <button type="button" class="overlay-close" onClick={props.onClose}>
        close
      </button>
      <div class="history-head">
        <p class="muted small">
          {tree().rows.length} versions
          <Show when={tree().heads > 1}> · {tree().heads} heads, the newest is current</Show>
        </p>
        <p class="muted small keys">↑↓ select · esc close</p>
      </div>

      <div class="history-main">
      <div
        class="tree"
        role="list"
        aria-label="versions"
        tabindex="0"
        ref={list}
        style={{ 'padding-left': `${tree().lanes * LANE + 8}px` }}
      >
        <svg class="tree-graph" width={tree().lanes * LANE} height={tree().rows.length * ROW} aria-hidden="true">
          <For each={tree().edges}>
            {(edge) => {
              const from = tree().rows[edge.from];
              const to = tree().rows[edge.to];
              const x0 = from.lane * LANE + LANE / 2;
              const x1 = to.lane * LANE + LANE / 2;
              const y0 = edge.from * ROW + ROW / 2;
              const y1 = edge.to * ROW + ROW / 2;
              const middle = (y0 + y1) / 2;
              const d =
                x0 === x1 ? `M${x0} ${y0}L${x1} ${y1}` : `M${x0} ${y0}C${x0} ${middle} ${x1} ${middle} ${x1} ${y1}`;
              return <path class="edge" d={d} />;
            }}
          </For>
          <For each={tree().rows}>
            {(row, index) => (
              <g class="node">
                <circle
                  cx={row.lane * LANE + LANE / 2}
                  cy={index() * ROW + ROW / 2}
                  r={row.current || row.children === 0 ? 4.6 : 3.4}
                  classList={{ current: row.current, head: !row.current && row.children === 0 }}
                />
                <Show when={row.children > 1}>
                  <circle class="fork" cx={row.lane * LANE + LANE / 2} cy={index() * ROW + ROW / 2} r={7.5} />
                </Show>
              </g>
            )}
          </For>
        </svg>

        <For each={tree().rows} fallback={<p class="muted">no versions yet</p>}>
          {(row, index) => (
            <div
              id={`v-${row.id}`}
              role="listitem"
              aria-current={selected()?.id === row.id}
              class="vrow"
              classList={{ selected: selected()?.id === row.id }}
              style={{ height: `${ROW}px` }}
              onClick={() => setPicked(row.id)}
            >
              <span class="vid">{shortId(row.id)}</span>
              <span class="vwhen muted">{ago(row.created)}</span>
              <Show when={row.current}>
                <span class="vtag">current</span>
              </Show>
              <Show when={!row.current && row.children === 0}>
                <span class="vtag branch">branch</span>
              </Show>
              <Show when={row.children > 1}>
                <span class="vtag muted-tag">fork</span>
              </Show>
            </div>
          )}
        </For>
      </div>

      <aside class="version-preview" aria-label="version preview">
        <p class="muted small">
          <Show when={selected()} fallback="nothing selected">
            {(version) => (
              <>
                {shortId(version().id)} · {ago(version().created)}
                <Show when={isCurrent()}> · current</Show>
              </>
            )}
          </Show>
        </p>
        <Show when={body()} fallback={<p class="muted small">nothing to show</p>}>
          {(text) => <pre class="version-body">{text() || '(empty)'}</pre>}
        </Show>
      </aside>
      </div>

    </section>
  );
}
