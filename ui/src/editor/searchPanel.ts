// ⌘/Ctrl+F: one text field over the editor, nothing else. Literal matching only — no regexp, no
// replace, no toggles, no buttons. Enter and Shift+Enter step, Escape closes.
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  SearchQuery,
  searchPanelOpen,
  setSearchQuery,
} from '@codemirror/search';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';

/** ⌘/Ctrl+F: open the field, or close it if it is already there. */
export function toggleSearch(view: EditorView): boolean {
  if (searchPanelOpen(view.state)) {
    closeSearchPanel(view);
    return true;
  }
  return openSearchPanel(view);
}

export function minimalSearchPanel(view: EditorView): Panel {
  const input = document.createElement('input');
  input.type = 'text';
  input.name = 'search';
  input.setAttribute('main-field', 'true'); // openSearchPanel finds and re-focuses this
  input.setAttribute('aria-label', 'search the note');
  input.placeholder = 'search';
  input.value = getSearchQuery(view.state).search;

  const commit = () =>
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: input.value, literal: true })),
    });
  input.addEventListener('input', commit);
  input.addEventListener('keydown', (event) => {
    // The panel is not the editor's content DOM, so the editor keymap never sees these keys; without
    // swallowing them, ⌘/Ctrl+F here opens the browser's own find on top of this one.
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'f' && !event.altKey) {
      event.preventDefault();
      toggleSearch(view);
      return;
    }
    if (event.key === 'F3' || (mod && key === 'g' && !event.altKey)) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(view);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(view);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(view);
    }
  });

  const dom = document.createElement('div');
  dom.className = 'cm-search-minimal';
  dom.append(input);

  return {
    dom,
    top: true,
    mount: () => {
      input.focus();
      input.select();
    },
    // A ⌘F with a selection reopens with that text as the query; keep the field in step.
    update: (update: ViewUpdate) => {
      for (const tr of update.transactions)
        for (const effect of tr.effects)
          if (effect.is(setSearchQuery) && effect.value.search !== input.value) input.value = effect.value.search;
    },
  };
}
