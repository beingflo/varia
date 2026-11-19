/** Pure op helpers — no SQL here, so they are cheap to test. */

/** Last-writer stamp, in the compact shape it is stored in JSON: lamport `l`, device `d`. */
export type Stamp = { l: number; d: string };

/** Total order over devices: lamport first, device id as the deterministic tiebreak. */
export function beats(a: Stamp, b: Stamp | null | undefined): boolean {
  if (!b) return true;
  return a.l > b.l || (a.l === b.l && a.d > b.d);
}

/** Display title for a text note: its first non-empty line, without heading marks. */
export function titleFromBody(body: string): string {
  const line = body
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s+/, '').trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  const title = line.startsWith('- ') || line.startsWith('* ') ? line.slice(2) : line;
  return title.length > 120 ? `${title.slice(0, 120)}…` : title;
}

/** Midpoint for inserting between two fractional orderings, without renumbering. */
export function between(prev: number | null, next: number | null): number {
  if (prev === null && next === null) return 1;
  if (prev === null) return (next as number) - 1;
  if (next === null) return prev + 1;
  return (prev + next) / 2;
}
