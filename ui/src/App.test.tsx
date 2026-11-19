import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testRepo } from './db/inProcess';
import { runCommand } from './lib/commands';
import { renderWithRepo } from './test-utils';
import App from './App';

// CodeMirror needs a real browser; the tests use the same props on a textarea.
vi.mock('./editor/Editor', async () => ({ default: (await import('./editor/TextareaDouble')).default }));

const mod = (command: Parameters<typeof runCommand>[0]) => runCommand(command);

describe('App', () => {
  afterEach(() => history.replaceState({}, '', '/'));

  it('restores the note named in the url', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'linked body');
    history.replaceState({}, '', `/note/${id}`);
    renderWithRepo(() => <App />, repo);

    await waitFor(() => expect(screen.getByLabelText('note body')).toHaveProperty('value', 'linked body'));
  });

  it('opens a list named in the url as a list', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo');
    await repo.setNoteMeta(id, { title: 'linked list' });
    history.replaceState({}, '', `/note/${id}`);
    renderWithRepo(() => <App />, repo);

    await waitFor(() => expect(screen.getByLabelText('list title')).toHaveProperty('value', 'linked list'));
  });

  it('drops a url naming a note that is gone', async () => {
    history.replaceState({}, '', '/note/missing');
    renderWithRepo(() => <App />, testRepo());

    await waitFor(() => expect(screen.getByLabelText('note body')).toHaveProperty('value', ''));
    expect(location.pathname).toBe('/');
  });

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
    await waitFor(() => expect(screen.getByLabelText('list title')).toHaveProperty('value', ''));
    expect(await repo.listNotes()).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByLabelText('new item'));
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

  it('saves the previous draft when a new note is requested right away', async () => {
    const repo = testRepo();
    renderWithRepo(() => <App />, repo);

    fireEvent.input(await screen.findByLabelText('note body'), { target: { value: 'alpha' } });
    mod('save');
    mod('new-note'); // no waiting between the two

    await waitFor(() => expect(screen.getByLabelText('note body')).toHaveProperty('value', ''));
    fireEvent.input(screen.getByLabelText('note body'), { target: { value: 'beta' } });
    mod('save');

    await waitFor(async () => expect(await repo.listNotes()).toHaveLength(2));
    const titles = (await repo.listNotes()).map((n) => n.title).sort();
    expect(titles).toEqual(['alpha', 'beta']);
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
