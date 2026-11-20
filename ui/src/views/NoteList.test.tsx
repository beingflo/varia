import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { testRepo } from '../db/inProcess';
import { renderWithRepo } from '../test-utils';
import NoteList from './NoteList';

async function seed() {
  const repo = testRepo();
  const lab = await repo.createNote('note');
  await repo.saveBody(lab, 'coalesce the retries');
  await repo.setNoteMeta(lab, { tags: ['lab'] });
  const list = await repo.createNote('todo', 'work');
  await repo.addItem(list, 'buy milk');
  return { repo, lab, list };
}

describe('Note list overlay', () => {
  it('lists notes and todo lists with their state', async () => {
    const { repo } = await seed();
    renderWithRepo(() => <NoteList onOpen={() => {}} onClose={() => {}} />, repo);

    expect(await screen.findByText('coalesce the retries')).toBeTruthy();
    // A list is marked with a trailing tilde, and carries its modification time like a note.
    expect(screen.getByText('work ~')).toBeTruthy();
  });

  it('filters by search text across notes and items', async () => {
    const { repo } = await seed();
    renderWithRepo(() => <NoteList onOpen={() => {}} onClose={() => {}} />, repo);

    await screen.findByText('coalesce the retries'); // the first page has to land before typing
    fireEvent.input(screen.getByLabelText('search notes'), { target: { value: 'milk' } });
    // The hit is an item text, so the list arrives through the item search, not the body.
    expect(await screen.findByText('work ~')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('coalesce the retries')).toBeNull());
  });

  it('opens the highlighted note with Enter and the clicked one with a click', async () => {
    const { repo, list } = await seed();
    const onOpen = vi.fn();
    renderWithRepo(() => <NoteList onOpen={onOpen} onClose={() => {}} />, repo);

    await screen.findByText('work ~');
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText('work ~'));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: list }));
  });

  it('moves the cursor with ctrl+j and ctrl+k', async () => {
    const { repo } = await seed();
    const onOpen = vi.fn();
    renderWithRepo(() => <NoteList onOpen={onOpen} onClose={() => {}} />, repo);

    await screen.findByText('work ~');
    const listed = await repo.listNotes();
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: listed[1].id })));

    onOpen.mockClear();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: listed[0].id })));
  });

  it('moves the cursor with the arrow keys', async () => {
    const { repo } = await seed();
    const onOpen = vi.fn();
    renderWithRepo(() => <NoteList onOpen={onOpen} onClose={() => {}} />, repo);

    await screen.findByText('work ~');
    const listed = await repo.listNotes(); // same order the view got
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: listed[1].id })));
  });

  it('does not move the cursor when the mouse passes over a note', async () => {
    const { repo } = await seed();
    const onOpen = vi.fn();
    renderWithRepo(() => <NoteList onOpen={onOpen} onClose={() => {}} />, repo);

    await screen.findByText('work ~');
    const listed = await repo.listNotes();
    const rows = document.querySelectorAll('.notes li');
    fireEvent.mouseOver(rows[1]);
    fireEvent.mouseEnter(rows[1]);
    fireEvent.keyDown(window, { key: 'Enter' });

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: listed[0].id })));
  });

  it('marks the note that is currently open', async () => {
    const { repo, list } = await seed();
    renderWithRepo(() => <NoteList onOpen={() => {}} onClose={() => {}} currentId={list} />, repo);

    await screen.findByText('work ~');
    const current = document.querySelector('.notes a[aria-current="true"]');
    expect(current?.textContent).toContain('work');
    expect(current?.querySelector('.dot')?.textContent).toBe('•');
    expect(document.querySelectorAll('.notes a[aria-current="true"]')).toHaveLength(1);
  });

  it('closes on escape', async () => {
    const { repo } = await seed();
    const onClose = vi.fn();
    renderWithRepo(() => <NoteList onOpen={() => {}} onClose={onClose} />, repo);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('offers tags and log entries in their own sections, and hides logs from the notes', async () => {
    const repo = testRepo();
    const work = await repo.createNote('note');
    await repo.saveBody(work, 'a real note\n\n#work');
    const log = await repo.createNote('note');
    await repo.saveBody(log, 'journal line\n\n#log #work');
    const onTag = vi.fn();
    renderWithRepo(() => <NoteList onOpen={() => {}} onClose={() => {}} onTag={onTag} />, repo);

    // An empty query already lists the tags: a stream is a place to go, not only a match.
    expect(await screen.findByText('#work')).toBeTruthy();
    expect(screen.getByText('journal line')).toBeTruthy(); // the log section
    expect(screen.getByText('a real note')).toBeTruthy();
    // Notes first, then logs, then the tag shortcuts.
    expect([...document.querySelectorAll('.row-head')].map((h) => h.textContent?.split(' ')[0])).toEqual([
      'notes',
      'logs',
      'tags',
    ]);

    fireEvent.click(screen.getByText('#work'));
    expect(onTag).toHaveBeenCalledWith('work');
  });

  it('answers only with tags once the query starts with #', async () => {
    const repo = testRepo();
    const work = await repo.createNote('note');
    await repo.saveBody(work, 'a real note\n\n#work');
    renderWithRepo(() => <NoteList onOpen={() => {}} onClose={() => {}} onTag={vi.fn()} />, repo);
    await screen.findByText('a real note');

    fireEvent.input(screen.getByLabelText('search notes'), { target: { value: '#wo' } });
    expect(await screen.findByText('#work')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('a real note')).toBeNull());
    expect(screen.getByText('#work')).toBeTruthy();
  });
});
