// CodeMirror 6 wrapper. The document is plain Markdown text: storage, history and sync never see
// anything but the source (design/004). Highlighting, list continuation and indentation are
// editor concerns only.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, HighlightStyle, syntaxTree, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { languages } from '@codemirror/language-data';
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
    // Not `fallback`: our code style is a second highlighter, and fallback would disable this one.
    syntaxHighlighting(defaultHighlightStyle),
    syntaxHighlighting(codeStyle),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    drawSelection(),
    codeBlockLines,
    EditorView.lineWrapping,
    theme,
    placeholder(props.placeholder ?? ''),
    EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel, 'aria-multiline': 'true' }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) props.onInput(update.state.doc.toString());
    }),
    EditorView.domEventHandlers({
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
