// CodeMirror 6 wrapper. The document is plain Markdown text: storage, history and sync never see
// anything but the source (design/004). Highlighting, list continuation and indentation are
// editor concerns only.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, HighlightStyle, syntaxTree, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { languages } from '@codemirror/language-data';
import { closeSearchPanel, findNext, findPrevious, search } from '@codemirror/search';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import {
  Decoration,
  drawSelection,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { createEffect, onCleanup, onMount } from 'solid-js';
import { linkAt, linksIn } from './links';
import { minimalSearchPanel, toggleSearch } from './searchPanel';

export type EditorApi = { focusEnd(): void };

// Fenced and indented code blocks get a line class: their content is tokenised by the embedded
// language, so it carries no monospace tag of its own.
const codeLine = Decoration.line({ class: 'cm-codeblock' });

function decorateCodeBlocks(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode' && node.name !== 'CodeBlock') return;
      const first = state.doc.lineAt(node.from).number;
      const last = state.doc.lineAt(node.to).number;
      for (let n = first; n <= last; n++) {
        const line = state.doc.line(n);
        builder.add(line.from, line.from, codeLine);
      }
      return false;
    },
  });
  return builder.finish();
}

/** The tag line at the end of a body is a footer, not a sentence: grey it so it reads as one. */
const tagLineMark = Decoration.mark({ class: 'cm-tagline' });

function decorateTagLine(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;
  // Same rule the database uses: the last non-empty line, and only tags on it.
  for (let n = doc.lines; n > 0; n--) {
    const line = doc.line(n);
    if (!line.text.trim()) continue;
    const tokens = line.text.trim().split(/\s+/);
    if (!tokens.every((token) => /^#[\p{L}\p{N}_-]+$/u.test(token))) break;
    const from = line.text.length - line.text.trimStart().length;
    builder.add(line.from + from, line.to, tagLineMark);
    break;
  }
  return builder.finish();
}

const tagLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorateTagLine(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = decorateTagLine(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const linkMark = Decoration.mark({ class: 'cm-link', attributes: { title: '⌘ or Ctrl + click to open' } });

function decorateLinks(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const range of view.visibleRanges) {
    for (const link of linksIn(view.state, range.from, range.to)) {
      // Ranges are clamped to whole lines, so two visible ranges can offer the same link.
      if (link.from < last) continue;
      builder.add(link.from, link.to, linkMark);
      last = link.to;
    }
  }
  return builder.finish();
}

const links = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorateLinks(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = decorateLinks(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const codeBlockLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorateCodeBlocks(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = decorateCodeBlocks(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// Code is code: monospace for inline code and fenced blocks, and the fence markers recede.
const codeStyle = HighlightStyle.define([
  { tag: tags.monospace, class: 'cm-code' },
  { tag: tags.processingInstruction, class: 'cm-markup', color: 'var(--fg)' },
]);

const theme = EditorView.theme({
  '&': {
    fontSize: '1rem',
    color: 'var(--fg)',
    backgroundColor: 'transparent',
    height: 'auto',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.7', overflow: 'visible' },
  '.cm-content': { padding: '0', caretColor: 'var(--fg)' },
  '.cm-line': { padding: '0' },
  '.cm-placeholder': { color: 'var(--muted)' },
  // Firefox gives an empty line's caret the whole line-box height (27px vs 20px with text), so
  // the caret is pinned to the text size instead of letting the browser decide.
  '.cm-cursor': { borderLeftColor: 'var(--fg)', height: '1.2em !important' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    { backgroundColor: 'color-mix(in srgb, var(--fg) 12%, transparent)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-code': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.95em' },
  // Inside a code block the line already sets the size; otherwise inline-code styling shrinks
  // fenced content twice and a block with a language looks bigger than one without.
  '.cm-codeblock .cm-code': { fontSize: 'inherit' },
  '.cm-codeblock': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.95em',
    backgroundColor: 'color-mix(in srgb, var(--fg) 4%, transparent)',
  },
  '.cm-markup': { color: 'var(--fg)' },
  // The tag line is the note's footer: muted, and its `#`s are markup like any other.
  '.cm-tagline': { color: 'var(--muted)' },
  '.cm-tagline .cm-markup': { color: 'var(--muted)' },
  // A link is a link in the source too: underlined, and it opens with the modifier held.
  '.cm-link': { textDecoration: 'underline', textUnderlineOffset: '2px', cursor: 'pointer' },
  // ⌘/Ctrl+F is the editor's own search (the browser's find cannot see unrendered lines, and a
  // note can be far taller than the viewport). It floats at the note column's top right, over the
  // text. `display: contents` removes CodeMirror's panel wrapper box: it otherwise paints a
  // full-width band with a border above the note, and its z-index 300 would top the overlays.
  '.cm-panels': { display: 'contents' },
  '.cm-panel.cm-search-minimal': {
    position: 'fixed', top: '1.25rem', zIndex: '20',
    right: 'max(1rem, calc((100vw - var(--measure)) / 2 + 0.75rem))',
    width: '11rem', maxWidth: 'calc(100vw - 2rem)',
    padding: '0.2rem 0.45rem',
    backgroundColor: 'var(--bg)', border: '1px solid var(--line)', borderRadius: '3px',
  },
  '.cm-panel.cm-search-minimal:focus-within': { borderColor: 'var(--muted)' },
  '.cm-search-minimal input': {
    width: '100%', padding: '0.05rem 0', font: 'inherit', fontSize: '0.85rem',
    color: 'var(--fg)', backgroundColor: 'transparent', border: 'none',
  },
  '.cm-search-minimal input:focus': { outline: 'none' },
  '.cm-search-minimal input::placeholder': { color: 'var(--muted)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 20%, transparent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--warn) 50%, transparent)' },
});

/**
 * Enter on a list item that has no content steps one level out; at the outermost level it
 * leaves the list. Stock CodeMirror left a stray marker behind in both cases.
 */
const emptyItemEnter = (view: EditorView): boolean => {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  const match = /^(\s*)([-*+]|\d+[.)])(\s*)$/.exec(line.text);
  if (!match) return false;

  const indent = match[1];
  const marker = match[2];
  const nested = indent.length >= 2;
  const insert = nested ? `${indent.slice(2)}${marker} ` : '';
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: line.from + insert.length },
    scrollIntoView: true,
    userEvent: 'delete',
  });
  return true;
};

function extensions(props: EditorProps): Extension[] {
  return [
    // Markdown first: Enter continues lists and quotes, Backspace undoes the marker.
    Prec.highest(keymap.of([{ key: 'Enter', run: emptyItemEnter }, ...markdownKeymap])),
    markdown({ codeLanguages: languages }),
    search({ literal: true, createPanel: minimalSearchPanel }),
    // Not `fallback`: our code style is a second highlighter, and fallback would disable this one.
    syntaxHighlighting(defaultHighlightStyle),
    syntaxHighlighting(codeStyle),
    history(),
    // Only what the search needs: toggle, next, previous. No regexp, replace or goto-line.
    keymap.of([
      { key: 'Mod-f', run: toggleSearch },
      { key: 'F3', run: findNext, shift: findPrevious },
      { key: 'Mod-g', run: findNext, shift: findPrevious },
      { key: 'Escape', run: closeSearchPanel },
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    drawSelection(),
    codeBlockLines,
    tagLines,
    links,
    EditorView.lineWrapping,
    theme,
    placeholder(props.placeholder ?? ''),
    EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel, 'aria-multiline': 'true' }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) props.onInput(update.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      // A plain click must still put the caret inside a URL (URLs are text you edit), so open
      // only with the modifier, like other markdown source editors.
      mousedown: (event, view) => {
        if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const href = pos === null ? undefined : linkAt(view.state, pos);
        if (!href) return false;
        event.preventDefault();
        window.open(href, '_blank', 'noopener,noreferrer');
        return true;
      },
      blur: () => {
        props.onBlur?.();
      },
    }),
  ];
}

export interface EditorProps {
  value: string;
  /** Changes when a different note is opened; undo history starts fresh, the view is reused. */
  docKey: string;
  ariaLabel: string;
  placeholder?: string;
  /** False in a dashboard tile: several editors must not grab the caret, and none scrolls the page. */
  autoFocus?: boolean;
  onInput(text: string): void;
  onBlur?(): void;
  onReady?(api: EditorApi): void;
}

export default function Editor(props: EditorProps) {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  let currentKey = props.docKey;

  const makeState = (doc: string) => EditorState.create({ doc, extensions: extensions(props) });

  const focus = () => {
    if (!view) return;
    view.focus();
    const end = view.state.doc.length;
    view.dispatch({ selection: { anchor: end }, scrollIntoView: false });
  };

  const focusEnd = () => {
    focus();
    window.scrollTo({ top: 0 });
  };

  onMount(() => {
    view = new EditorView({ state: makeState(props.value), parent: host! });
    props.onReady?.({ focusEnd });
    if (props.autoFocus !== false) focusEnd();
  });

  // The parent mirrors our own edits, so any real difference here came from outside: a note
  // switch (fresh state, fresh undo history) or a restore (same note, replace the document).
  createEffect(() => {
    const next = props.value;
    const key = props.docKey;
    if (!view) return;
    const doc = view.state.doc.toString();
    if (next === doc && key === currentKey) return;

    if (key !== currentKey) {
      currentKey = key;
      view.setState(makeState(next));
      if (props.autoFocus !== false) focusEnd();
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      selection: { anchor: next.length },
      scrollIntoView: false,
    });
  });

  onCleanup(() => view?.destroy());

  // The wrapper fills the viewport while the editor box is only as tall as its text, so a click
  // under the last line would otherwise hit the page and do nothing.
  const clickUnderText = (event: MouseEvent) => {
    if (!view || (event.target as Element).closest('.cm-editor')) return;
    event.preventDefault(); // the default action would blur the view we are about to focus
    if (props.autoFocus === false) focus();
    else focusEnd();
  };

  return <div class="editor" ref={host} onMouseDown={clickUnderText} />;
}
