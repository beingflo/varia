import { describe, expect, it } from 'vitest';
import type { VersionMeta } from '../db/types';
import { versionTree } from './versionTree';

const version = (id: string, parent: string | null, lamport: number, device = 'dev-a'): VersionMeta => ({
  id,
  parent_id: parent,
  lamport,
  device,
  created: 1_700_000_000_000 + lamport,
});

describe('versionTree', () => {
  it('draws a single-device history as one straight lane, newest first', () => {
    const tree = versionTree([version('c', 'b', 3), version('b', 'a', 2), version('a', null, 1)]);

    expect(tree.rows.map((row) => row.id)).toEqual(['c', 'b', 'a']);
    expect(tree.rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(tree.rows.map((row) => row.live)).toEqual([true, true, true]);
    expect(tree.rows.map((row) => row.current)).toEqual([true, false, false]);
    expect(tree.edges.map((edge) => [edge.from, edge.to])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(tree.lanes).toBe(1);
    expect(tree.heads).toBe(1);
  });

  it('opens a second lane at a fork and marks the branch the note is not on as closed', () => {
    // Two devices wrote from 'a'; 'b' wins the lamport race.
    const tree = versionTree([
      version('c', 'a', 5, 'dev-b'),
      version('b', 'a', 4, 'dev-a'),
      version('a', null, 3),
    ]);

    expect(tree.rows.map((row) => row.id)).toEqual(['c', 'b', 'a']);
    expect(tree.rows.map((row) => row.lane)).toEqual([0, 1, 0]);
    // Both branches are heads; the newest is the one the note shows.
    expect(tree.heads).toBe(2);
    expect(tree.rows.find((row) => row.id === 'c')?.current).toBe(true);
    expect(tree.rows.find((row) => row.id === 'b')?.live).toBe(false);
    expect(tree.rows.find((row) => row.id === 'a')?.children).toBe(2);
    // The closed branch's edge is dim, the live one is not.
    expect(tree.edges.map((edge) => [edge.from, edge.to, edge.live])).toEqual([
      [0, 2, true],
      [1, 2, false],
    ]);
    expect(tree.lanes).toBe(2);
  });

  it('reuses a freed lane instead of growing the graph', () => {
    // A restore-then-edit branch that already ended: 'd' continues from the head 'c'.
    const tree = versionTree([version('d', 'c', 6), version('c', 'b', 5), version('b', 'a', 2), version('a', null, 1)]);
    expect(tree.lanes).toBe(1);
    expect(tree.rows.map((row) => row.lane)).toEqual([0, 0, 0, 0]);
  });

  it('keeps versions whose parent never arrived, rather than dropping them', () => {
    const tree = versionTree([version('orphan', 'missing', 9)]);
    expect(tree.rows.map((row) => row.id)).toEqual(['orphan']);
    expect(tree.edges).toEqual([]);
    expect(tree.rows[0].live).toBe(true); // a lone head is the current one
  });
});
