import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { testRepo } from '../db/inProcess';
import { renderWithRepo } from '../test-utils';
import Notes from './Notes';

async function seed() {
  const repo = testRepo();
  const lab = await repo.createNote('note');
  await repo.saveBody(lab, 'coalesce the retries');
  await repo.setNoteMeta(lab, { tags: ['lab'] });
  const list = await repo.createNote('todo', 'work');
  await repo.addItem(list, 'buy milk');
  return { repo, lab, list };
}

describe('Notes list', () => {
  it('lists notes and todo lists with their state', async () => {
    const { repo } = await seed();
    renderWithRepo(() => <Notes />, repo);

    expect(await screen.findByText('coalesce the retries')).toBeTruthy();
    expect(screen.getByText('work')).toBeTruthy();
    expect(screen.getByText('1 open')).toBeTruthy();
  });

  it('filters by search text across notes and items', async () => {
    const { repo } = await seed();
    renderWithRepo(() => <Notes />, repo);

    fireEvent.input(screen.getByPlaceholderText('search'), { target: { value: 'milk' } });
    expect(await screen.findByText('work')).toBeTruthy();
    expect(screen.queryByText('coalesce the retries')).toBeNull();
  });

  it('filters by tag chip', async () => {
    const { repo } = await seed();
    renderWithRepo(() => <Notes />, repo);

    fireEvent.click(await screen.findByText('lab'));
    expect(await screen.findByText('coalesce the retries')).toBeTruthy();
    expect(screen.queryByText('work')).toBeNull();
  });

  it('creates a note and navigates to it', async () => {
    const repo = testRepo();
    renderWithRepo(() => <Notes />, repo);

    fireEvent.click((await screen.findAllByText('note'))[0]);
    await waitFor(() => expect(location.pathname).toMatch(/^\/note\/[0-9a-f-]{36}$/));
    expect(await repo.listNotes()).toHaveLength(1);
  });
});
