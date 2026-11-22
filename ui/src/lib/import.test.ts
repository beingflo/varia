import { describe, expect, it } from 'vitest';
import { parseImportFile } from './import';

const note = (overrides: Record<string, unknown> = {}) => ({
  createdAt: '2026-11-20T21:52:22.982216+00:00',
  modifiedAt: '2026-11-21T08:00:00+00:00',
  body: '## Varia test sync token\n\nbody',
  ...overrides,
});

const file = (...notes: Record<string, unknown>[]) => JSON.stringify({ count: notes.length, notes });

describe('parseImportFile', () => {
  it('keeps both dates and the body', () => {
    expect(parseImportFile(file(note()))).toEqual([
      {
        createdAt: Date.parse('2026-11-20T21:52:22.982216+00:00'),
        modifiedAt: Date.parse('2026-11-21T08:00:00+00:00'),
        body: '## Varia test sync token\n\nbody',
      },
    ]);
  });

  it('rejects what the importer cannot write', () => {
    expect(() => parseImportFile('not json')).toThrow(/not valid JSON/);
    expect(() => parseImportFile('[]')).toThrow(/"notes" array/);
    expect(() => parseImportFile('{"notes":[]}')).toThrow(/no notes/);
    expect(() => parseImportFile(file(note({ createdAt: 'yesterday' })))).toThrow(/createdAt/);
    expect(() => parseImportFile(file(note({ body: 42 })))).toThrow(/body must be a string/);
    expect(() => parseImportFile(file(note({ body: 'x'.repeat(4_500_001) })))).toThrow(/could never sync/);
  });

  it('reports every problem, capped', () => {
    const bad = Array.from({ length: 8 }, () => note({ createdAt: 'nope' }));
    expect(() => parseImportFile(file(...bad))).toThrow(/8 problems[\s\S]*and 3 more/);
  });
});
