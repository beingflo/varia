import { describe, expect, it } from 'vitest';
import { beats, between, tagLine, tagsOfLastLine, titleFromBody, withoutTagLine } from './ops';

describe('stamps', () => {
  it('orders by lamport, then device', () => {
    expect(beats({ l: 2, d: 'a' }, { l: 1, d: 'z' })).toBe(true);
    expect(beats({ l: 1, d: 'z' }, { l: 2, d: 'a' })).toBe(false);
    expect(beats({ l: 1, d: 'b' }, { l: 1, d: 'a' })).toBe(true);
    expect(beats({ l: 1, d: 'a' }, { l: 1, d: 'a' })).toBe(false);
  });

  it('wins against nothing', () => {
    expect(beats({ l: 0, d: '' }, undefined)).toBe(true);
  });
});

describe('titles', () => {
  it('takes the first non-empty line without heading marks', () => {
    expect(titleFromBody('\n\n## Plan\nrest')).toBe('Plan');
    expect(titleFromBody('- buy milk\n- eggs')).toBe('buy milk');
    expect(titleFromBody('   ')).toBe('');
  });

  it('truncates long titles', () => {
    expect(titleFromBody('x'.repeat(200))).toHaveLength(121);
  });
});

describe('fractional ordering', () => {
  it('appends, prepends and splits', () => {
    expect(between(null, null)).toBe(1);
    expect(between(null, 5)).toBe(4);
    expect(between(5, null)).toBe(6);
    expect(between(1, 2)).toBe(1.5);
  });
});

describe('tag lines', () => {
  it('reads tags only from a line that is nothing but tags', () => {
    expect(tagsOfLastLine('entry\n\n#work #urgent')).toEqual(['work', 'urgent']);
    expect(tagsOfLastLine('entry\n\n#work\n')).toEqual(['work']);
    // A heading, a sentence, or a tag sharing the line with text claims nothing.
    expect(tagsOfLastLine('# Work\nbody')).toEqual([]);
    expect(tagsOfLastLine('fixed #work')).toEqual([]);
    expect(tagsOfLastLine('')).toEqual([]);
  });

  it('strips exactly that line, and nothing else', () => {
    expect(withoutTagLine('entry\n\n#work')).toBe('entry');
    expect(withoutTagLine('a\n\nb\n\n#work #log\n')).toBe('a\n\nb');
    // No tag line: the body comes back untouched, blank lines included.
    expect(withoutTagLine('a\n\nb\n')).toBe('a\n\nb\n');
  });

  it('writes the line back in the shape it reads', () => {
    expect(tagLine(['log', 'work'])).toBe('\n\n#log #work');
  });
});
