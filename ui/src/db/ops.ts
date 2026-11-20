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

const lastLine = (body: string) => body.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';

/**
 * Tags named by the last line, and only when that line is nothing but tags: `#work #urgent`. A
 * heading or a sentence ending in a tag is not a tag line, so a note cannot claim a tag by accident.
 */
export function tagsOfLastLine(body: string): string[] {
  const tokens = lastLine(body).split(/\s+/).filter(Boolean);
  if (!tokens.length || !tokens.every((token) => /^#[\p{L}\p{N}_-]+$/u.test(token))) return [];
  return tokens.map((token) => token.slice(1));
}

/** The tag line as it is written back: blank line, then the tags. */
export const tagLine = (tags: string[]): string => `\n\n${tags.map((tag) => `#${tag}`).join(' ')}`;

/** The body without its trailing tag line: a tag stream shows the entry, not the frame. */
export function withoutTagLine(body: string): string {
  if (!tagsOfLastLine(body).length) return body;
  const lines = body.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.pop();
  return lines.join('\n').replace(/\n+$/, '');
}

/**
 * Midpoint for inserting between two fractional orderings, without renumbering.
 * shortcut: ~45 inserts into the same slot exhaust double precision and the row then lands after
 * `next`; renumber the siblings locally if a list ever gets that dense in one place
 */
export function between(prev: number | null, next: number | null): number {
  if (prev === null && next === null) return 1;
  if (prev === null) return (next as number) - 1;
  if (next === null) return prev + 1;
  return (prev + next) / 2;
}
