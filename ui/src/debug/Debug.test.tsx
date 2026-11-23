import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { testRepo } from '../db/inProcess';
import { render } from '@solidjs/testing-library';
import Debug from './Debug';

async function seed() {
  const repo = testRepo();
  const id = await repo.createNote('note');
  await repo.saveBody(id, 'first');
  await repo.saveBody(id, 'second');
  return repo;
}

describe('Debug overlay', () => {
  it('lists tables with counts and shows the op log', async () => {
    const repo = await seed();
    render(() => <Debug repo={repo} onClose={() => {}} />);

    expect(await screen.findByLabelText('table op')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('table op'));

    await waitFor(() => expect(screen.getAllByText('note_snapshot').length).toBeGreaterThan(0));
    expect(screen.getByText('kind')).toBeTruthy();
    expect(document.querySelector('.toolbar')?.textContent).toContain('of 3');
  });

  it('switches tables and pages through rows', async () => {
    const repo = await seed();
    render(() => <Debug repo={repo} onClose={() => {}} />);

    fireEvent.click(await screen.findByLabelText('table version'));
    await waitFor(() => expect(screen.getByText('second')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('table note'));
    await waitFor(() => expect(screen.getByText('stamps')).toBeTruthy());
  });

  it('probes the search index: how much is indexed, the plan, and the time', async () => {
    const repo = await seed();
    render(() => <Debug repo={repo} onClose={() => {}} />);

    // Counts arrive without a query: one note, one document in the index.
    await waitFor(() => expect(document.querySelector('.probe')?.textContent).toContain('index 1 / notes 1'));

    fireEvent.input(screen.getByLabelText('probe search'), { target: { value: 'second' } });
    fireEvent.click(screen.getByText('check'));

    // The statement has to be answered by the index, not by scanning the notes.
    await waitFor(() => expect(document.querySelector('.probe .plan')?.textContent).toContain('VIRTUAL TABLE'));
    expect(document.querySelector('.probe')?.textContent).toContain('1 hits');
  });

  it('shows the whole row as json when clicked', async () => {
    const repo = await seed();
    render(() => <Debug repo={repo} onClose={() => {}} />);

    fireEvent.click(await screen.findByLabelText('table version'));
    await waitFor(() => expect(document.querySelectorAll('tbody tr')).toHaveLength(2));
    fireEvent.click(document.querySelectorAll('tbody tr')[1]);

    await waitFor(() => expect(document.querySelector('pre')?.textContent ?? '').toContain('"parent_id"'));
  });

  it('closes on escape', async () => {
    const repo = await seed();
    const onClose = vi.fn();
    render(() => <Debug repo={repo} onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a query error instead of silently rendering nothing', async () => {
    const repo = await seed();
    const broken = { ...repo, debugRows: async () => Promise.reject(new Error('nope')) };
    render(() => <Debug repo={broken} onClose={() => {}} />);

    expect(await screen.findByText(/query failed: nope/)).toBeTruthy();
  });
});
