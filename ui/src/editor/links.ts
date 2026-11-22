// Links in the Markdown source: what the editor underlines and what ⌘/Ctrl-click opens.
// Markdown links and autolinks come from the syntax tree; bare URLs do not (CommonMark has no
// autolink for them), so those are found per line. Code is never a link.
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

export type LinkRange = { from: number; to: number; href: string };

const CODE = new Set(['InlineCode', 'FencedCode', 'CodeBlock']);
const BARE = /https?:\/\/[^\s<>()[\]]+/gi;

/** Only http(s) leaves the app: no `javascript:`, no relative paths. */
const httpUrl = (raw: string): string | undefined => {
  const url = raw.replace(/[.,;:!?'"]+$/, '');
  return /^https?:\/\/\S+$/i.test(url) ? url : undefined;
};

/**
 * `[label](url)` as the source text it is: the destination is what the link points at. Turndown
 * (the one-off importer) escapes parentheses in a destination, so `\(` is a real `(`.
 */
const target = (linkText: string): string | undefined =>
  /\]\(\s*<?((?:\\.|[^\s)<>])+)/.exec(linkText)?.[1]?.replace(/\\(.)/g, '$1');

const inCode = (state: EditorState, pos: number): boolean => {
  // Structural, so this file needs nothing from @lezer/common to walk parents.
  let node: { name: string; parent: { name: string; parent: unknown } | null } | null = syntaxTree(state).resolveInner(pos, 1);
  while (node) {
    if (CODE.has(node.name)) return true;
    node = node.parent as typeof node;
  }
  return false;
};

/** Every openable range between two document positions, in order. */
export function linksIn(state: EditorState, from: number, to: number): LinkRange[] {
  const found: LinkRange[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (node.name !== 'Link' && node.name !== 'Autolink') return;
      const text = state.doc.sliceString(node.from, node.to);
      const href = httpUrl(node.name === 'Autolink' ? text.slice(1, -1) : (target(text) ?? ''));
      if (href) found.push({ from: node.from, to: node.to, href });
      return false; // nothing inside a link is a second link
    },
  });

  for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n += 1) {
    const line = state.doc.line(n);
    for (const match of line.text.matchAll(BARE)) {
      const href = httpUrl(match[0]);
      if (!href) continue;
      const start = line.from + (match.index ?? 0);
      const end = start + match[0].replace(/[.,;:!?'"]+$/, '').length;
      if (found.some((link) => start < link.to && end > link.from)) continue; // the `(url)` of a link
      if (inCode(state, start)) continue;
      found.push({ from: start, to: end, href });
    }
  }
  return found.sort((a, b) => a.from - b.from);
}

/** The link under a document position, if it is one. */
export function linkAt(state: EditorState, pos: number): string | undefined {
  const line = state.doc.lineAt(pos);
  return linksIn(state, line.from, line.to).find((link) => pos >= link.from && pos < link.to)?.href;
}
