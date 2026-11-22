import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { linkAt, linksIn } from './links';

const state = (doc: string) => EditorState.create({ doc, extensions: [markdown()] });

/** The offset of the nth occurrence of a snippet: where a click would land. */
const at = (doc: string, snippet: string, nth = 0) => {
  let index = -1;
  for (let i = 0; i <= nth; i += 1) index = doc.indexOf(snippet, index + 1);
  return index + Math.floor(snippet.length / 2);
};

describe('links', () => {
  it('opens a markdown link from its label and from its target', () => {
    const doc = '## [marending.dev](http://marending.dev) landing page ideas';
    expect(linkAt(state(doc), at(doc, 'marending.dev'))).toBe('http://marending.dev');
    expect(linkAt(state(doc), at(doc, 'http://marending.dev'))).toBe('http://marending.dev');
    expect(linkAt(state(doc), at(doc, 'landing page'))).toBeUndefined();
  });

  it('finds bare URLs and leaves the punctuation out', () => {
    const doc = 'read https://castel.dev/posts, then https://keepitfree.ai/.';
    const links = linksIn(state(doc), 0, doc.length);
    expect(links.map((link) => link.href)).toEqual(['https://castel.dev/posts', 'https://keepitfree.ai/']);
    expect(linkAt(state(doc), at(doc, 'castel.dev'))).toBe('https://castel.dev/posts');
    expect(linkAt(state(doc), at(doc, 'keepitfree.ai/'))).toBe('https://keepitfree.ai/');
    expect(linkAt(state(doc), doc.length - 1)).toBeUndefined();
  });

  it('opens autolinks but not code, relative paths or other schemes', () => {
    const autolink = 'see <https://szymonkaliski.com/bio/>';
    expect(linkAt(state(autolink), at(autolink, 'szymonkaliski'))).toBe('https://szymonkaliski.com/bio/');

    const inline = 'not `https://code.example/` here';
    expect(linkAt(state(inline), at(inline, 'https://code.example/'))).toBeUndefined();

    const fenced = '```\nhttps://fenced.example/\n```';
    expect(linkAt(state(fenced), at(fenced, 'https://fenced.example/'))).toBeUndefined();

    const relative = '[a relative link](./notes.md)';
    expect(linkAt(state(relative), at(relative, './notes.md'))).toBeUndefined();

    const script = '[click](javascript:alert(1))';
    expect(linkAt(state(script), at(script, 'javascript'))).toBeUndefined();

    expect(linkAt(state('www.example.com'), 3)).toBeUndefined();
  });

  it('unescapes the parentheses turndown puts in a destination', () => {
    const doc = '[wiki](https://en.wikipedia.test/wiki/Foo\\(bar\\))';
    expect(linkAt(state(doc), at(doc, 'wiki'))).toBe('https://en.wikipedia.test/wiki/Foo(bar)');
  });

  it('counts the target of a link once, not as a bare URL too', () => {
    const doc = '[https://mfashby.net/posts/](https://mfashby.net/posts/)';
    expect(linksIn(state(doc), 0, doc.length)).toHaveLength(1);
    expect(linkAt(state(doc), at(doc, 'mfashby', 0))).toBe('https://mfashby.net/posts/');
  });
});
