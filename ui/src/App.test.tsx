import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { testRepo } from './db/inProcess';
import { runCommand } from './lib/commands';
import { renderWithRepo } from './test-utils';
import App from './App';

const mod = (command: Parameters<typeof runCommand>[0]) => runCommand(command);

describe('App', () => {
  it('lands on an empty draft and creates nothing', async () => {
    const repo = testRepo();
    renderWithRepo(() => <App />, repo);

    await waitFor(() => expect(screen.getByLabelText('note body')).toHaveProperty('value', ''));
    await new Promise((r) => setTimeout(r, 20));
    expect(await repo.listNotes()).toHaveLength(0);
  });

  it('opens the note list with the list command and closes it again', async () => {
    const repo = testRepo();
    renderWithRepo(() => <App />, repo);

    mod('list');
    expect(await screen.findByLabelText('search notes')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('search notes')).toBeNull());
  });

  it('gives the caret back to the editor after the list closes', async () => {
    const repo = testRepo();
    renderWithRepo(() => <App />, repo);

    const editor = await screen.findByLabelText('note body');
    expect(document.activeElement).toBe(editor);

    mod('list');
    await screen.findByLabelText('search notes');
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('note body')));
  });

  it('creates a todo list with the new-list command and shows it', async () => {
    const repo = testRepo();
    renderWithRepo(() => <App />, repo);

    mod('new-list');
    await waitFor(() => expect(screen.getByLabelText('list title')).toHaveProperty('value', 'list'));
    expect(await repo.listNotes()).toHaveLength(1);
  });

  it('keeps the text on screen after saving a draft', async () => {
    const repo = testRepo();
    renderWithRepo(() => <App />, repo);

    const editor = await screen.findByLabelText('note body');
    fireEvent.input(editor, { target: { value: 'keep me' } });
    runCommand('save');

    await waitFor(async () => expect(await repo.listNotes()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByLabelText('note body')).toHaveProperty('value', 'keep me');
  });

  it('returns to a fresh draft with the new-note command', async () => {
    const repo = testRepo();
    renderWithRepo(() => <App />, repo);

    const editor = await screen.findByLabelText('note body');
    fireEvent.input(editor, { target: { value: 'something' } });
    fireEvent.blur(editor);
    await waitFor(async () => expect(await repo.listNotes()).toHaveLength(1));

    mod('new-note');
    await waitFor(() => expect(screen.getByLabelText('note body')).toHaveProperty('value', ''));
  });

  it('deletes the open note with the delete command', async () => {
    const repo = testRepo();
    renderWithRepo(() => <App />, repo);

    fireEvent.input(await screen.findByLabelText('note body'), { target: { value: 'doomed' } });
    fireEvent.blur(screen.getByLabelText('note body'));
    await waitFor(async () => expect(await repo.listNotes()).toHaveLength(1));

    mod('delete');
    await waitFor(async () => expect(await repo.listNotes()).toHaveLength(0));
    expect(screen.getByLabelText('note body')).toHaveProperty('value', '');
  });

  it('flushes an unsaved draft before switching to the list', async () => {
    const repo = testRepo();
    renderWithRepo(() => <App />, repo);

    fireEvent.input(await screen.findByLabelText('note body'), {
      target: { value: 'draft that must survive the switch' },
    });
    mod('list');

    await waitFor(async () => expect(await repo.listNotes()).toHaveLength(1));
    expect(((await repo.listNotes())[0] as { title: string }).title).toBe('draft that must survive the switch');
  });
});
