import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testRepo } from '../db/inProcess';
import { runCommand } from '../lib/commands';
import { flushAll } from '../lib/flush';
import { renderWithRepo } from '../test-utils';
import TagView from './TagView';

// CodeMirror needs a real browser; the tests use the same props on a textarea.
vi.mock('../editor/Editor', async () => ({ default: (await import('../editor/TextareaDouble')).default }));

/** `created` is the writer's clock, so the test sets it: ordering is the point of the view. */
function clock() {
  let now = 1_700_000_000_000;
  return vi.spyOn(Date, 'now').mockImplementation(() => now++);
}

async function seed() {
  const repo = testRepo();
  const first = await repo.createNote('note');
  await repo.saveBody(first, 'sync with X about the parser\n\ntried a bigger buffer\n\n#work');
  const second = await repo.createNote('note');
  await repo.saveBody(second, 'the retry loop was the bug\n\n#work');
  const board = await repo.createNote('note');
  await repo.saveBody(board, '# Boards\n\n{"note":"a","w":1,"h":1}\n\n#dashboard');
  return { repo, first, second, board };
}

afterEach(() => vi.restoreAllMocks());

describe('tag stream', () => {
  it('shows the entries newest first, whole, their tag line muted at the end', async () => {
    clock();
    const { repo } = await seed();
    renderWithRepo(() => <TagView tag="work" onOpen={() => {}} />, repo);

    const entries = await screen.findAllByText(/retry loop|sync with X/);
    expect(entries[0].textContent).toContain('the retry loop was the bug');
    // The tag line is part of the entry, drawn apart so it can be muted.
    expect(entries[1].querySelector('.tag-foot')?.textContent).toBe('#work');
    expect(entries[1].textContent).toBe('sync with X about the parser\n\ntried a bigger buffer\n#work');
    expect(screen.getByText('work')).toBeTruthy();
    expect(screen.getByText('2 entries')).toBeTruthy(); // on the far side of the header
  });

  it('names a board instead of rendering its layout JSON', async () => {
    clock();
    const { repo } = await seed();
    renderWithRepo(() => <TagView tag="dashboard" onOpen={() => {}} />, repo);

    const entry = await screen.findByText(/Boards — ▦ 1 tile/);
    expect(entry.textContent).toBe('Boards — ▦ 1 tile\n#dashboard');
  });

  it('links an entry to its note, so a modified click can open a tab', async () => {
    clock();
    const { repo, second } = await seed();
    const onOpen = vi.fn();
    renderWithRepo(() => <TagView tag="work" onOpen={onOpen} />, repo);

    const link = (await screen.findByText(/retry loop/)).parentElement!.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(`/note/${second}`);
    // A plain click stays in the app; a modified one is left to the browser, which jsdom cannot do.
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link, { metaKey: true });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: second }));
  });

  it('files a new entry under the stream tag, and only ⌘S ends it', async () => {
    clock();
    const { repo } = await seed();
    renderWithRepo(() => <TagView tag="work" onOpen={() => {}} />, repo);
    await screen.findByText(/retry loop/);

    runCommand('new-entry');
    const editor = (await screen.findByLabelText('note body')) as HTMLTextAreaElement;
    fireEvent.input(editor, { target: { value: 'a fresh entry\n\nthe caret was the problem' } });
    runCommand('save');

    await waitFor(async () => {
      const entries = await repo.listNotes({ tag: 'work', sort: 'created' });
      expect(entries.length).toBe(3);
      expect(entries[0].body).toBe('a fresh entry\n\nthe caret was the problem\n\n#work');
    });
    // The draft is gone: the entry is read-only in the stream now.
    await waitFor(() => expect(screen.queryByLabelText('note body')).toBeNull());
    const entry = await screen.findByText(/a fresh entry/);
    expect(entry.textContent).toBe('a fresh entry\n\nthe caret was the problem\n#work');
  });

  it('keeps the tag line out of the document, so a background flush cannot cost the entry its tag', async () => {
    clock();
    const { repo } = await seed();
    renderWithRepo(() => <TagView tag="work" onOpen={() => {}} />, repo);
    await screen.findByText(/retry loop/);

    runCommand('new-entry');
    const editor = (await screen.findByLabelText('note body')) as HTMLTextAreaElement;
    fireEvent.input(editor, { target: { value: 'a longer thought' } });
    // A sync (or the tab hiding) flushes: the note exists now, but nobody said "done".
    await flushAll(true);
    expect(await repo.listNotes({ tag: 'work' })).toHaveLength(3);
    expect((await repo.listNotes({ tag: 'work', sort: 'created' }))[0].body).toBe('a longer thought\n\n#work');

    // Writing on: the caret is nowhere near a tag line, because the document has none.
    expect(editor.value).toBe('a longer thought');
    fireEvent.input(editor, { target: { value: 'a longer thought\nand then some' } });
    runCommand('save');

    await waitFor(async () => {
      const entries = await repo.listNotes({ tag: 'work', sort: 'created' });
      expect(entries[0].body).toBe('a longer thought\nand then some\n\n#work');
      // One tag line, not one per save.
      expect(entries[0].body.match(/#work/g)).toHaveLength(1);
    });
    expect(await screen.findByText(/and then some/)).toBeTruthy();
  });

  it('pages with "load older" instead of rendering the whole history', async () => {
    clock();
    const repo = testRepo();
    for (let i = 0; i < 27; i++) {
      const id = await repo.createNote('note');
      await repo.saveBody(id, `entry ${i}\n\n#work`);
    }
    renderWithRepo(() => <TagView tag="work" onOpen={() => {}} />, repo);

    expect(await screen.findByText('entry 26')).toBeTruthy();
    expect(screen.queryByText('entry 0')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'load older' }));
    expect(await screen.findByText('entry 0')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'load older' })).toBeNull());
  });
});
