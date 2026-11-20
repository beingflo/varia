import { describe, expect, it } from 'vitest';
import { diffLines } from './diff';

const shape = (before: string, after: string) => diffLines(before, after).map((row) => `${row.kind[0]} ${row.text}`);

describe('diffLines', () => {
  it('reports a changed line as a removal and an addition', () => {
    expect(shape('one\ntwo\nthree', 'one\nTWO\nthree')).toEqual(['e one', 'r two', 'a TWO', 'e three']);
  });

  it('trims the unchanged head and tail and keeps them as equal rows', () => {
    expect(shape('one\ntwo', 'one\ntwo')).toEqual(['e one', 'e two']);
    expect(shape('a\nb\nc\nd', 'a\nb\nc\nd\ne')).toEqual(['e a', 'e b', 'e c', 'e d', 'a e']);
  });

  it('treats an empty body as no lines', () => {
    expect(shape('', 'a\nb')).toEqual(['a a', 'a b']);
    expect(shape('a\nb', '')).toEqual(['r a', 'r b']);
    expect(shape('', '')).toEqual([]);
  });

  it('counts an empty line as a line', () => {
    expect(shape('a\n\nb', 'a\nb')).toEqual(['e a', 'r ', 'e b']);
  });

  it('keeps a moved line as a removal and an addition', () => {
    expect(shape('a\nb\nc', 'b\nc\na')).toEqual(['r a', 'e b', 'e c', 'a a']);
  });

  it('falls back to replaced-wholesale when the difference is huge', () => {
    const before = Array.from({ length: 2500 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 2500 }, (_, i) => `new ${i}`).join('\n');
    const rows = diffLines(before, after);
    expect(rows).toHaveLength(5000);
    expect(rows[0].kind).toBe('removed');
    expect(rows.at(-1)!.kind).toBe('added');
  });
});
