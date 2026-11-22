import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { testRepo } from '../db/inProcess';
import { renderWithRepo } from '../test-utils';
import Import from './Import';

const file = (content: unknown, name = 'notes.json') =>
  new File([JSON.stringify(content)], name, { type: 'application/json' });

const note = (oldId: number) => ({
  oldId,
  createdAt: '2026-11-20T21:52:22.982216+00:00',
  modifiedAt: '2026-11-21T08:00:00+00:00',
  body: `## note ${oldId}\n\nbody`,
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
    await waitFor(async () => expect((await repo.listNotes()).map((n) => n.id)).toEqual(['fn-1', 'fn-2']));
  });

  it('says what is wrong with the file instead of importing it', async () => {
    const repo = testRepo();
    renderWithRepo(() => <Import onClose={() => {}} />, repo);
    pick(screen.getByLabelText('import file') as HTMLInputElement, file({ notes: [{ oldId: 1 }] }));
    await screen.findByText(/proble/);
    expect(await repo.listNotes()).toHaveLength(0);
  });

  it('shows why the repo refused a second import of the same file', async () => {
    const repo = testRepo();
    renderWithRepo(() => <Import onClose={() => {}} />, repo);
    const input = screen.getByLabelText('import file') as HTMLInputElement;

    pick(input, file({ notes: [note(1)] }));
    await screen.findByText(/1 notes ready/);
    fireEvent.click(screen.getByRole('button', { name: 'import 1 notes' }));
    await screen.findByText(/1 notes imported/);

    pick(input, file({ notes: [note(1)] }));
    await screen.findByText(/1 notes ready/);
    fireEvent.click(screen.getByRole('button', { name: 'import 1 notes' }));
    await screen.findByText(/already here/);
    await waitFor(async () => expect(await repo.listNotes()).toHaveLength(1));
  });
});
