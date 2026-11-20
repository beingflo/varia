import type { VersionMeta } from '../db/types';

export type TreeRow = VersionMeta & {
  /** Column the node sits in. Lanes are packed, so a straight history stays in lane 0. */
  lane: number;
  /** An ancestor of (or) the current head: the branch the note's body came from. */
  live: boolean;
  /** Versions written from this one. More than one means two devices diverged here. */
  children: number;
  /** The head the note shows: highest `(lamport, device)` of all heads. */
  current: boolean;
};

export type TreeEdge = { from: number; to: number; live: boolean };

export type VersionTree = {
  rows: TreeRow[];
  edges: TreeEdge[];
  /** Lanes in use, i.e. the graph's width in columns. */
  lanes: number;
  heads: number;
};

/**
 * Lays a note's versions out as a git-style graph (design/002: one parent, many children).
 *
 * Rows are ordered topologically, newest first: a version appears only once all of its children
 * have, so a shared ancestor always sits below both branches. Lanes are assigned in that same
 * walk — a lane waits for the parent it is heading to, and a version claimed by two lanes closes
 * the higher one, which is the diagonal where branches meet again.
 */
export function versionTree(versions: VersionMeta[]): VersionTree {
  const byId = new Map(versions.map((version) => [version.id, version]));
  const children = new Map<string, string[]>();
  for (const version of versions) {
    if (!version.parent_id || !byId.has(version.parent_id)) continue;
    children.set(version.parent_id, [...(children.get(version.parent_id) ?? []), version.id]);
  }

  const newestFirst = (a: VersionMeta, b: VersionMeta) =>
    b.lamport - a.lamport || b.device.localeCompare(a.device) || a.id.localeCompare(b.id);

  // Kahn's algorithm against the child edges: everything with no unplaced child is ready.
  const waiting = new Map(versions.map((version) => [version.id, children.get(version.id)?.length ?? 0]));
  let ready = versions.filter((version) => waiting.get(version.id) === 0).sort(newestFirst);
  const order: VersionMeta[] = [];
  while (ready.length > 0) {
    const version = ready.shift()!;
    order.push(version);
    const parent = version.parent_id ? byId.get(version.parent_id) : undefined;
    if (!parent) continue;
    const left = (waiting.get(parent.id) ?? 0) - 1;
    waiting.set(parent.id, left);
    if (left === 0) ready = [...ready, parent].sort(newestFirst);
  }
  // A malformed log (a cycle, or a parent that never synced) must still list every version.
  if (order.length < versions.length) {
    const placed = new Set(order.map((version) => version.id));
    order.push(...versions.filter((version) => !placed.has(version.id)).sort(newestFirst));
  }

  // The head `heads` are ordered by; the note's body is the newest of them.
  const headIds = versions.filter((version) => !children.has(version.id)).map((version) => version.id);
  const currentId = [...versions].filter((v) => headIds.includes(v.id)).sort(newestFirst)[0]?.id;

  const live = new Set<string>();
  let at: string | undefined = currentId;
  while (at !== undefined && !live.has(at)) {
    live.add(at);
    at = byId.get(at)?.parent_id ?? undefined;
  }

  const lanes: (string | null)[] = [];
  const rows: TreeRow[] = [];
  const rowOf = new Map<string, number>();
  for (const version of order) {
    let lane = lanes.indexOf(version.id);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(null);
      }
    }
    // Any other lane that was waiting for this version ends here: branches meeting again.
    for (let i = 0; i < lanes.length; i++) if (i !== lane && lanes[i] === version.id) lanes[i] = null;
    lanes[lane] = version.parent_id && byId.has(version.parent_id) ? version.parent_id : null;
    rowOf.set(version.id, rows.length);
    rows.push({
      ...version,
      lane,
      live: live.has(version.id),
      children: children.get(version.id)?.length ?? 0,
      current: version.id === currentId,
    });
  }

  const edges: TreeEdge[] = [];
  for (const row of rows) {
    const to = row.parent_id ? rowOf.get(row.parent_id) : undefined;
    if (to === undefined) continue;
    edges.push({ from: rowOf.get(row.id)!, to, live: row.live });
  }

  return { rows, edges, lanes: Math.max(1, lanes.length), heads: headIds.length };
}
