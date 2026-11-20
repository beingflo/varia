import { describe, expect, it } from 'vitest';
import { formatBoard, isDashboard, moved, parseBoard, resized, tagsOfLastLine, withTile, withoutTile } from './board';

const tile = (note: string, w = 1, h = 1) => JSON.stringify({ note, w, h });

describe('dashboard bodies', () => {
  it('is a note whose last line is only tags naming a dashboard', () => {
    expect(isDashboard('# Work\n\n#dashboard\n')).toBe(true);
    expect(isDashboard('# Work\n\ntext\n#todo #dashboard')).toBe(true);
    // A heading or prose ending in a tag is not a tag line.
    expect(isDashboard('# Work\n\n## Notes')).toBe(false);
    expect(isDashboard('# Work\n\nask about the #dashboard later')).toBe(false);
    expect(isDashboard('# Work\n\n#worked')).toBe(false);
    expect(tagsOfLastLine('a\n#work #urgent')).toEqual(['work', 'urgent']);
  });

  it('round-trips through the body, one line per tile', () => {
    const board = { title: 'Work', tiles: [{ note: 'a', w: 2, h: 1 }, { note: 'b', w: 1, h: 3 }] };
    const body = formatBoard(board);
    expect(body.split('\n').filter((line) => line.startsWith('{'))).toEqual([tile('a', 2, 1), tile('b', 1, 3)]);
    expect(parseBoard(body)).toEqual(board);
    expect(isDashboard(body)).toBe(true);
  });

  it('keeps the title in the note list when the board is empty', () => {
    const body = formatBoard({ title: '', tiles: [] });
    expect(parseBoard(body)).toEqual({ title: 'Board', tiles: [] });
  });

  it('drops what it cannot read instead of failing', () => {
    const body = `# Work\n\n{"note":"a"}\n{ broken\n\n42\nnot json at all\n\n#dashboard`;
    expect(parseBoard(body).tiles).toEqual([{ note: 'a', w: 1, h: 1 }]);
    expect(parseBoard('').tiles).toEqual([]);
  });

  it('clamps sizes and keeps one tile per note', () => {
    const body = `# Work\n${tile('a', 9, 0)}\n${tile('a', 2, 2)}\n${tile('b', 1.6, 2)}\n#dashboard`;
    expect(parseBoard(body).tiles).toEqual([
      { note: 'a', w: 3, h: 1 },
      { note: 'b', w: 2, h: 2 },
    ]);
    // The third height is the full one, and beyond it there is nothing to clamp to.
    expect(parseBoard(`# W\n${tile('c', 1, 9)}\n#dashboard`).tiles[0]).toEqual({ note: 'c', w: 1, h: 3 });
  });

  it('edits tiles without touching the others', () => {
    const board = { title: 'W', tiles: [{ note: 'a', w: 1, h: 1 }, { note: 'b', w: 1, h: 1 }] };
    expect(withTile(board, 'c').tiles.map((t) => t.note)).toEqual(['a', 'b', 'c']);
    expect(withTile(board, 'a')).toBe(board);
    expect(withoutTile(board, 'a').tiles.map((t) => t.note)).toEqual(['b']);
    expect(resized(board, 1, { w: 3 }).tiles[1]).toEqual({ note: 'b', w: 3, h: 1 });
    expect(resized(board, 0, { w: 4 }).tiles[0].w).toBe(3);
    expect(resized(board, 0, { h: 4 }).tiles[0].h).toBe(3);
    // Out-of-range moves are no-ops, not out-of-bounds reads.
    expect(moved(board, 0, -1)).toBe(board);
    expect(moved(board, 1, 1)).toBe(board);
  });

  it('reorders by moving the tile objects, so the editors under them survive', () => {
    const board = { title: 'W', tiles: [{ note: 'a', w: 1, h: 1 }, { note: 'b', w: 1, h: 1 }] };
    const next = moved(board, 0, 1);
    expect(next.tiles.map((t) => t.note)).toEqual(['b', 'a']);
    expect(next.tiles[1]).toBe(board.tiles[0]);
  });
});
