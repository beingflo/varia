import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { testRepo } from '../db/inProcess';
import { renderWithRepo } from '../test-utils';
import Import from './Import';

const file = (content: unknown, name = 'notes.json') =>
  new File([JSON.stringify(content)], name, { type: 'application/json' });

const note = (n: number) => ({
  createdAt: '2026-11-20T21:52:22.982216+00:00',
  modifiedAt: '2026-11-21T08:00:00+00:00',
  body: `## note ${n}\n\nbody`,
});

function pick(input: HTMLInputElement, picked: File) {
  Object.defineProperty(input, 'files', { value: [picked], configurable: true });
  fireEvent.change(input);
}

describe('import overlay', () => {
  it('reports the format, then writes the notes on confirm', async () => {
    const repo = testRepo();
    renderWithRepo(() => <Import onClose={() => {}} />, repo);
    const button = screen.getByRole('button', { name: 'import' });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    pick(screen.getByLabelText('import file') as HTMLInputElement, file({ notes: [note(1), note(2)] }));
    await screen.findByText(/format ok — 2 notes ready to import/);

    fireEvent.click(screen.getByRole('button', { name: 'import 2 notes' }));
    await screen.findByText(/2 notes imported/);
    await waitFor(async () => expect((await repo.listNotes()).map((n) => n.title).sort()).toEqual(['note 1', 'note 2']));
  });

  it('says what is wrong with the file instead of importing it', async () => {
    const repo = testRepo();
    renderWithRepo(() => <Import onClose={() => {}} />, repo);
    pick(screen.getByLabelText('import file') as HTMLInputElement, file({ notes: [{ body: 'no dates' }] }));
    await screen.findByText(/proble/);
    expect(await repo.listNotes()).toHaveLength(0);
  });

  it('imports the same file twice as two sets of notes, since every import mints ids', async () => {
    const repo = testRepo();
    renderWithRepo(() => <Import onClose={() => {}} />, repo);
    const input = screen.getByLabelText('import file') as HTMLInputElement;

    for (let i = 0; i < 2; i += 1) {
      pick(input, file({ notes: [note(1)] }));
      await screen.findByText(/1 notes ready/);
      fireEvent.click(screen.getByRole('button', { name: 'import 1 notes' }));
      await screen.findByText(/1 notes imported/);
    }

    await waitFor(async () => expect(await repo.listNotes()).toHaveLength(2));
  });
});
