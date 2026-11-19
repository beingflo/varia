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
    expect(screen.getByText('work')).toBeTruthy();
    expect(screen.getByText('1 open')).toBeTruthy();
  });

  it('filters by search text across notes and items', async () => {
    const { repo } = await seed();
    renderWithRepo(() => <NoteList onOpen={() => {}} onClose={() => {}} />, repo);

    fireEvent.input(screen.getByLabelText('search notes'), { target: { value: 'milk' } });
    await waitFor(() => expect(screen.queryByText('coalesce the retries')).toBeNull());
    expect(screen.getByText('work')).toBeTruthy();
  });

  it('opens the highlighted note with Enter and the clicked one with a click', async () => {
    const { repo, list } = await seed();
    const onOpen = vi.fn();
    renderWithRepo(() => <NoteList onOpen={onOpen} onClose={() => {}} />, repo);

    await screen.findByText('work');
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText('work'));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: list }));
  });

  it('moves the cursor with ctrl+j and ctrl+k', async () => {
    const { repo } = await seed();
    const onOpen = vi.fn();
    renderWithRepo(() => <NoteList onOpen={onOpen} onClose={() => {}} />, repo);

    await screen.findByText('work');
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

    await screen.findByText('work');
    const listed = await repo.listNotes(); // same order the view got
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: listed[1].id })));
  });

  it('closes on escape', async () => {
    const { repo } = await seed();
    const onClose = vi.fn();
    renderWithRepo(() => <NoteList onOpen={() => {}} onClose={onClose} />, repo);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
