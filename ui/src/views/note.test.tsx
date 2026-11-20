import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { testRepo } from '../db/inProcess';
import { runCommand } from '../lib/commands';
import { renderWithRepo } from '../test-utils';
import NoteView from './NoteView';

// CodeMirror needs a real browser; the tests use the same props on a textarea.
vi.mock('../editor/Editor', async () => ({ default: (await import('../editor/TextareaDouble')).default }));

describe('Note view', () => {
  it('does not create a note for an empty draft', async () => {
    const repo = testRepo();
    renderWithRepo(() => <NoteView />, repo);

    const editor = await screen.findByLabelText('note body');
    fireEvent.blur(editor);
    runCommand('save');

    await new Promise((r) => setTimeout(r, 20));
    expect(await repo.listNotes()).toHaveLength(0);
  });

  it('creates the draft on save, only once', async () => {
    const repo = testRepo();
    const created = vi.fn();
    renderWithRepo(() => <NoteView onCreated={created} />, repo);

    fireEvent.input(screen.getByLabelText('note body'), { target: { value: '# Lab notes\nfirst try' } });
    runCommand('save');

    await waitFor(async () => expect(await repo.listNotes()).toHaveLength(1));
    const [note] = await repo.listNotes();
    expect(note.title).toBe('Lab notes');
    expect(created).toHaveBeenCalledWith(note.id);

    runCommand('save');
    await new Promise((r) => setTimeout(r, 20));
    expect(await repo.listNotes()).toHaveLength(1);
  });

  it('does not write an empty version when saving before the note has loaded', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'content');
    const slow = {
      ...repo,
      getNote: async (noteId: string) => {
        await new Promise((r) => setTimeout(r, 40));
        return repo.getNote(noteId);
      },
    };
    renderWithRepo(() => <NoteView id={id} />, slow);

    runCommand('save'); // the body is not on screen yet
    await new Promise((r) => setTimeout(r, 120));
    expect((await repo.versions(id)).map((v) => v.id)).toHaveLength(1);
  });

  it('saves on blur, not while typing', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    renderWithRepo(() => <NoteView id={id} />, repo);

    const editor = await screen.findByLabelText('note body');
    fireEvent.input(editor, { target: { value: 'typed but not blurred' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(await repo.versions(id)).toHaveLength(0);

    fireEvent.blur(editor);
    await waitFor(async () => expect(await repo.versions(id)).toHaveLength(1));
  });

  it('takes a pulled version instead of re-committing the text on screen', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'local');
    renderWithRepo(() => <NoteView id={id} />, repo);
    await waitFor(() => expect(screen.getByLabelText('note body')).toHaveProperty('value', 'local'));

    // Another device's snapshot wins the lamport race while the editor is clean.
    await repo.applyRemote([
      {
        device: 'dev-b',
        id: 'op-remote',
        kind: 'note_snapshot',
        note_id: id,
        lamport: 99,
        created: Date.now(),
        payload: { version_id: 'version-remote', parent_version_id: null, body: 'from the other device' },
      },
    ]);

    runCommand('save'); // a flush on the clean editor, as sync and blur send
    await waitFor(() => expect(screen.getByLabelText('note body')).toHaveProperty('value', 'from the other device'));
    expect((await repo.versions(id)).map((v) => v.id)).toHaveLength(2);
    expect((await repo.getNote(id))!.body).toBe('from the other device');
  });

  it('keeps local text when it was edited and a version arrives', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'local');
    renderWithRepo(() => <NoteView id={id} />, repo);
    const editor = await screen.findByLabelText('note body');
    await waitFor(() => expect(editor).toHaveProperty('value', 'local'));
    fireEvent.input(editor, { target: { value: 'my own edit' } });

    await repo.applyRemote([
      {
        device: 'dev-b',
        id: 'op-remote',
        kind: 'note_snapshot',
        note_id: id,
        lamport: 99,
        created: Date.now(),
        payload: { version_id: 'version-remote', parent_version_id: null, body: 'theirs' },
      },
    ]);
    fireEvent.blur(editor);
    await waitFor(async () => expect(await repo.versions(id)).toHaveLength(3));
    expect((await repo.getNote(id))!.body).toBe('my own edit');
    expect(await repo.heads(id)).toHaveLength(2);
  });

  it('writes one version for two flushes of the same text', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    renderWithRepo(() => <NoteView id={id} />, repo);

    const editor = await screen.findByLabelText('note body');
    fireEvent.input(editor, { target: { value: 'typed once' } });
    // A blur and the save command land back to back, before either write resolves: both capture
    // the same text and the same (stale) baseline.
    fireEvent.blur(editor);
    runCommand('save');
    runCommand('save');

    await waitFor(async () => expect(await repo.versions(id)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect((await repo.getNote(id))!.body).toBe('typed once');
  });

  it('writes no new version when nothing changed', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    const created = await repo.saveBody(id, 'same');
    renderWithRepo(() => <NoteView id={id} />, repo);

    const editor = await screen.findByLabelText('note body');
    await waitFor(() => expect(editor).toHaveProperty('value', 'same'));
    fireEvent.blur(editor);
    runCommand('save');

    await new Promise((r) => setTimeout(r, 20));
    expect(created).toBe(true);
    expect(await repo.versions(id)).toHaveLength(1);
  });

  it('shows the selected version read-only and writes nothing until keep', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'first');
    await repo.saveBody(id, 'second');
    renderWithRepo(() => <NoteView id={id} />, repo);

    runCommand('history');
    const rows = await waitFor(() => {
      const found = document.querySelectorAll('.vrow');
      expect(found.length).toBe(2);
      return found;
    });
    fireEvent.click(rows[1]); // the older one

    // The preview follows the selection; browsing writes nothing.
    await waitFor(() => expect(document.querySelector('.version-body')?.textContent).toBe('first'));
    expect(await repo.versions(id)).toHaveLength(2);
    expect((await repo.getNote(id))!.body).toBe('second');
    expect(screen.getByLabelText('note body')).toHaveProperty('value', 'second');
  });

  it('loads one body per selected version, not the whole history', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    for (let n = 1; n <= 30; n += 1) await repo.saveBody(id, `version ${n}`);
    const seen: string[] = [];
    const versionPair = repo.versionPair.bind(repo);
    repo.versionPair = async (noteId, versionId) => {
      seen.push(versionId);
      return versionPair(noteId, versionId);
    };
    // Freeze the clock out of it: every snapshot here lands in the same millisecond.
    renderWithRepo(() => <NoteView id={id} />, repo);
    runCommand('history');

    const rows = await waitFor(() => {
      const found = document.querySelectorAll('.vrow');
      expect(found.length).toBe(30);
      return found;
    });
    await waitFor(() => expect(document.querySelector('.version-body')?.textContent).toBe('version 30'));
    expect(seen).toHaveLength(1);

    fireEvent.click(rows[1]);
    await waitFor(() => expect(document.querySelector('.version-body')?.textContent).toBe('version 29'));
    expect(seen).toHaveLength(2);
  });

  it('takes a pulled version instead of re-committing the text on screen', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'local');
    renderWithRepo(() => <NoteView id={id} />, repo);
    await waitFor(() => expect(screen.getByLabelText('note body')).toHaveProperty('value', 'local'));

    // Another device's snapshot wins the lamport race while the editor is clean.
    await repo.applyRemote([
      {
        device: 'dev-b',
        id: 'op-remote',
        kind: 'note_snapshot',
        note_id: id,
        lamport: 99,
        created: Date.now(),
        payload: { version_id: 'version-remote', parent_version_id: null, body: 'from the other device' },
      },
    ]);

    runCommand('save'); // a flush on the clean editor, as sync and blur send
    await waitFor(() => expect(screen.getByLabelText('note body')).toHaveProperty('value', 'from the other device'));
    expect((await repo.versions(id)).map((v) => v.id)).toHaveLength(2);
    expect((await repo.getNote(id))!.body).toBe('from the other device');
  });

  it('keeps local text when it was edited and a version arrives', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'local');
    renderWithRepo(() => <NoteView id={id} />, repo);
    const editor = await screen.findByLabelText('note body');
    await waitFor(() => expect(editor).toHaveProperty('value', 'local'));
    fireEvent.input(editor, { target: { value: 'my own edit' } });

    await repo.applyRemote([
      {
        device: 'dev-b',
        id: 'op-remote',
        kind: 'note_snapshot',
        note_id: id,
        lamport: 99,
        created: Date.now(),
        payload: { version_id: 'version-remote', parent_version_id: null, body: 'theirs' },
      },
    ]);
    fireEvent.blur(editor);
    await waitFor(async () => expect(await repo.versions(id)).toHaveLength(3));
    expect((await repo.getNote(id))!.body).toBe('my own edit');
    expect(await repo.heads(id)).toHaveLength(2);
  });

  it('writes one version for two flushes of the same text', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    renderWithRepo(() => <NoteView id={id} />, repo);

    const editor = await screen.findByLabelText('note body');
    fireEvent.input(editor, { target: { value: 'typed once' } });
    // A blur and the save command land back to back, before either write resolves: both capture
    // the same text and the same (stale) baseline.
    fireEvent.blur(editor);
    runCommand('save');
    runCommand('save');

    await waitFor(async () => expect(await repo.versions(id)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect((await repo.getNote(id))!.body).toBe('typed once');
  });

  it('writes no new version when nothing changed', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    const created = await repo.saveBody(id, 'same');
    renderWithRepo(() => <NoteView id={id} />, repo);

    const editor = await screen.findByLabelText('note body');
    await waitFor(() => expect(editor).toHaveProperty('value', 'same'));
    fireEvent.blur(editor);
    runCommand('save');

    await new Promise((r) => setTimeout(r, 20));
    expect(created).toBe(true);
    expect(await repo.versions(id)).toHaveLength(1);
  });

  it('shows the selected version read-only and writes nothing until keep', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'first');
    await repo.saveBody(id, 'second');
    renderWithRepo(() => <NoteView id={id} />, repo);

    runCommand('history');
    const rows = await waitFor(() => {
      const found = document.querySelectorAll('.vrow');
      expect(found.length).toBe(2);
      return found;
    });
    fireEvent.click(rows[1]); // the older one

    // The preview follows the selection; browsing writes nothing.
    await waitFor(() => expect(document.querySelector('.version-body')?.textContent).toBe('first'));
    expect(await repo.versions(id)).toHaveLength(2);
    expect((await repo.getNote(id))!.body).toBe('second');
    expect(screen.getByLabelText('note body')).toHaveProperty('value', 'second');
  });

  it('loads one body per selected version, not the whole history', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    for (let n = 1; n <= 30; n += 1) await repo.saveBody(id, `version ${n}`);
    const seen: string[] = [];
    const versionPair = repo.versionPair.bind(repo);
    repo.versionPair = async (noteId, versionId) => {
      seen.push(versionId);
      return versionPair(noteId, versionId);
    };
    // Freeze the clock out of it: every snapshot here lands in the same millisecond.
    renderWithRepo(() => <NoteView id={id} />, repo);
    runCommand('history');

    const rows = await waitFor(() => {
      const found = document.querySelectorAll('.vrow');
      expect(found.length).toBe(30);
      return found;
    });
    await waitFor(() => expect(document.querySelector('.version-body')?.textContent).toBe('version 30'));
    expect(seen).toHaveLength(1);

    fireEvent.click(rows[1]);
    await waitFor(() => expect(document.querySelector('.version-body')?.textContent).toBe('version 29'));
    expect(seen).toHaveLength(2);
  });
});
