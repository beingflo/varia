import { tagsOfLastLine, titleFromBody } from '../db/ops';

/**
 * A dashboard is an ordinary note (design/002): its last line names the tag `dashboard`, its first
 * line is the title heading, and every tile is one JSON object on its own line. Nothing is stored
 * outside the body, so a layout change is one changed line in the note's version tree.
 */
export type Tile = { note: string; w: number; h: number };
export type Board = { title: string; tiles: Tile[] };

const TAG = 'dashboard';
const MIN = 1;
/** Three steps each: the third width is the whole row, the third height the rest of the viewport. */
const MAX_W = 3;
const MAX_H = 3;

export { tagsOfLastLine };

export const isDashboard = (body: string): boolean => tagsOfLastLine(body).includes(TAG);

const step = (value: unknown, max: number): number => {
  const size = Math.round(Number(value));
  return Number.isFinite(size) ? Math.min(Math.max(size, MIN), max) : MIN;
};

/**
 * Tolerant by design: a body that was half-written, hand-edited or pulled from a device that did
 * not know about tiles still opens, with the lines it does not understand dropped.
 */
export function parseBoard(body: string): Board {
  const tiles: Tile[] = [];
  const seen = new Set<string>();
  for (const line of body.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let tile: { note?: unknown; w?: unknown; h?: unknown };
    try {
      tile = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof tile?.note !== 'string' || !tile.note || seen.has(tile.note)) continue; // one tile per note
    seen.add(tile.note);
    tiles.push({ note: tile.note, w: step(tile.w, MAX_W), h: step(tile.h, MAX_H) });
  }
  return { title: titleFromBody(body), tiles };
}

/** One line per tile, so the differ in the history pane shows one changed tile per line. */
export function formatBoard(board: Board): string {
  // A board always has a heading: it is the note's title in the list, and without it the first
  // tile's JSON would be mistaken for it.
  const title = board.title.trim() || 'Board';
  const tiles = board.tiles.map((tile) =>
    JSON.stringify({ note: tile.note, w: step(tile.w, MAX_W), h: step(tile.h, MAX_H) }),
  );
  return [`# ${title}`, '', ...tiles, ...(tiles.length ? [''] : []), `#${TAG}`, ''].join('\n');
}

export function withTile(board: Board, note: string): Board {
  if (board.tiles.some((tile) => tile.note === note)) return board;
  return { ...board, tiles: [...board.tiles, { note, w: MIN, h: MIN }] };
}

export const withoutTile = (board: Board, note: string): Board => ({
  ...board,
  tiles: board.tiles.filter((tile) => tile.note !== note),
});

/** Reordering keeps the tile objects, so the editors below them are moved, never rebuilt. */
export function moved(board: Board, index: number, delta: number): Board {
  const to = index + delta;
  if (to < 0 || to >= board.tiles.length || index < 0 || index >= board.tiles.length) return board;
  const tiles = [...board.tiles];
  [tiles[index], tiles[to]] = [tiles[to], tiles[index]];
  return { ...board, tiles };
}

export function resized(board: Board, index: number, patch: { w?: number; h?: number }): Board {
  const tile = board.tiles[index];
  if (!tile) return board;
  return {
    ...board,
    tiles: board.tiles.map((current, i) =>
      i === index
        ? { ...current, w: step(patch.w ?? tile.w, MAX_W), h: step(patch.h ?? tile.h, MAX_H) }
        : current,
    ),
  };
}
