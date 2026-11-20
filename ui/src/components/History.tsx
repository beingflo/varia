import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { useRepo } from '../db/context';
import type { VersionMeta } from '../db/types';
import { ago } from '../lib/time';
import { parseAcknowledged, shortId } from '../lib/versions';
import { versionTree } from '../lib/versionTree';

/** Row height and lane width in px: the graph is drawn from the same numbers the rows use. */
const ROW = 30;
const LANE = 22;

const flat = (snippet: string) => snippet.replace(/\s+/g, ' ').trim() || '(empty)';

/**
 * The version tree of one note (design/002): one parent, many children, never a merge. Selection
 * is inert — `open` checks a version out into the editor without writing anything, `keep` makes it
 * the current text and acknowledges the other branches.
 */
export default function History(props: {
  noteId: string;
  onClose: () => void;
  onOpen: (version: VersionMeta, body: string) => void;
  onKept: () => void;
}) {
  const repo = useRepo();
  const [versions] = createResource(() => props.noteId, (id) => repo.versions(id));
  const tree = createMemo(() => versionTree(versions() ?? []));
  /** Leaves of the tree: more than one means two devices wrote from the same version. */
  const branches = createMemo(() => tree().rows.filter((row) => row.children === 0));

  const [picked, setPicked] = createSignal<string | null>(null);
  const selected = createMemo<VersionMeta | undefined>(() => {
    const rows = tree().rows;
    return rows.find((row) => row.id === picked()) ?? rows[0];
  });
  const current = createMemo(() => tree().rows.find((row) => row.current)?.id);
  const isCurrent = () => selected()?.id === current();

  let list: HTMLDivElement | undefined;

  // The selection must be visible when it moves past the fold.
  createEffect(() => {
    const id = selected()?.id;
    if (!id) return;
    // jsdom has no scrollIntoView; the test suite renders this overlay too.
    (list?.querySelector(`#v-${id}`) as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  });

  const open = async () => {
    const version = selected();
    if (!version || version.id === current()) return;
    const body = await repo.versionBody(props.noteId, version.id);
    if (body === undefined) return;
    props.onOpen(version, body);
  };

  // Keeping a version is a snapshot on the current head, plus the bookkeeping that says the other
  // branches have been dealt with. It writes nothing when the text is already the head's.
  const keep = async () => {
    const version = selected();
    if (!version || version.id === current()) return;
    const acknowledged = parseAcknowledged(await repo.getNote(props.noteId));
    const others = branches().filter((branch) => branch.id !== current()).map((branch) => branch.id);
    await repo.restoreVersion(props.noteId, version.id);
    await repo.setNoteMeta(props.noteId, { acknowledged: [...new Set([...acknowledged, ...others])] });
    props.onKept();
    props.onClose();
  };

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
      else if (event.key === 'Enter') {
        event.preventDefault();
        void open();
      }
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
      <div class="history-head">
        <p class="muted small">
          {tree().rows.length} versions · {tree().heads === 1 ? 'one branch' : `${tree().heads} branches`}
          <Show when={tree().heads > 1}> · the newest is current</Show>
        </p>
        <p class="muted small">↑↓ select · enter open in editor · esc close</p>
      </div>

      <div
        class="tree"
        role="listbox"
        aria-label="versions"
        tabindex="0"
        aria-activedescendant={selected() ? `v-${selected()!.id}` : undefined}
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
              return <path class="edge" classList={{ closed: !edge.live }} d={d} />;
            }}
          </For>
          <For each={tree().rows}>
            {(row, index) => (
              <g class="node" classList={{ closed: !row.live }}>
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
              role="option"
              aria-selected={selected()?.id === row.id}
              class="vrow"
              classList={{ selected: selected()?.id === row.id, closed: !row.live }}
              style={{ height: `${ROW}px` }}
              onClick={() => setPicked(row.id)}
              onDblClick={() => void open()}
            >
              <span class="vid">{shortId(row.id)}</span>
              <span class="vwhen muted">{ago(row.created)}</span>
              <span class="vsnip">{flat(row.snippet)}</span>
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

      <div class="history-bar">
        <span class="muted small">
          <Show when={selected()} fallback="nothing selected">
            {(version) => (
              <>
                {shortId(version().id)} · {ago(version().created)}
                <Show when={isCurrent()}> · this is the current version</Show>
                <Show when={!isCurrent() && !tree().rows.find((r) => r.id === version().id)?.live}> · closed branch</Show>
              </>
            )}
          </Show>
        </span>
        <div class="actions">
          <button class="btn" disabled={!selected() || isCurrent()} onClick={() => void open()}>
            open in editor
          </button>
          <button class="btn primary" disabled={!selected() || isCurrent()} onClick={() => void keep()}>
            keep this version
          </button>
        </div>
      </div>
    </section>
  );
}
