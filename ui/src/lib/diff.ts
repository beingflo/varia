/** Line diff for the history pane: pure text in, rows out, no state and no dependency. */

export type DiffLine = { kind: 'equal' | 'removed' | 'added'; text: string };

/** Lines of a body; the empty body is no lines at all, not one empty line. */
const lines = (text: string): string[] => (text === '' ? [] : text.split('\n'));

/**
 * A removed row followed by an added row is what the history pane shows as a modified line; there
 * is no separate kind, and the pairing is the reader's eye rather than a second algorithm.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);

  // Matching head and tail are free and shrink the table the rest needs.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const rows: DiffLine[] = [];
  for (let i = 0; i < start; i += 1) rows.push({ kind: 'equal', text: a[i] });
  rows.push(...middle(a.slice(start, endA), b.slice(start, endB)));
  for (let i = endA; i < a.length; i += 1) rows.push({ kind: 'equal', text: a[i] });
  return rows;
}

function middle(a: string[], b: string[]): DiffLine[] {
  // shortcut: the table is quadratic, so a pair of enormous blocks is shown as replaced wholesale;
  // switch to Myers with a bandwidth if notes grow past a few thousand changed lines.
  if (a.length * b.length > 4_000_000) {
    return [...a.map((text) => ({ kind: 'removed' as const, text })), ...b.map((text) => ({ kind: 'added' as const, text }))];
  }

  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // Suffix LCS lengths, so walking forward can decide each row from the table once.
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const rows: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'equal', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      rows.push({ kind: 'removed', text: a[i] }); // removals first, like every diff a reader knows
      i += 1;
    } else {
      rows.push({ kind: 'added', text: b[j] });
      j += 1;
    }
  }
  for (; i < n; i += 1) rows.push({ kind: 'removed', text: a[i] });
  for (; j < m; j += 1) rows.push({ kind: 'added', text: b[j] });
  return rows;
}
