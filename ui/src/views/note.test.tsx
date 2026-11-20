import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
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

  it('pulses the stamp only when a save leaves its label unchanged', async () => {
    const animate = vi.fn();
    Element.prototype.animate = animate as unknown as Element['animate'];
    const repo = testRepo();
    renderWithRepo(() => <NoteView />, repo);
    const editor = await screen.findByLabelText('note body');

    fireEvent.input(editor, { target: { value: 'first' } });
    runCommand('save');
    await waitFor(() => expect(screen.getByText('now')).toBeTruthy());
    expect(animate).not.toHaveBeenCalled(); // "now" appeared, that is feedback enough

    fireEvent.input(editor, { target: { value: 'second' } });
    runCommand('save');
    await waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
    // CodeMirror replaces the editor in a real browser; the stamp is the element being pulsed.
    expect(animate.mock.instances[0]).toBe(screen.getByText('now'));
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
    expect((await repo.versions(id)).map((v) => v.snippet)).toEqual(['content']);
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

  it('opens history, checks an old version out, and writes only when edited', async () => {
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
    fireEvent.click(screen.getByText('open in editor'));

    // Checkout is not a write: the history is still two versions, and so is the database.
    await waitFor(() => expect(screen.getByLabelText('note body')).toHaveProperty('value', 'first'));
    expect(await repo.versions(id)).toHaveLength(2);
    expect((await repo.getNote(id))!.body).toBe('second');

    // The first edit branches from the checked-out version instead of continuing the head.
    fireEvent.input(screen.getByLabelText('note body'), { target: { value: 'first, edited' } });
    fireEvent.blur(screen.getByLabelText('note body'));
    await waitFor(async () => expect(await repo.versions(id)).toHaveLength(3));
    const versions = await repo.versions(id);
    const edited = versions.find((version) => version.snippet === 'first, edited')!;
    const first = versions.find((version) => version.snippet === 'first')!;
    expect(edited.parent_id).toBe(first.id);
    expect(await repo.heads(id)).toHaveLength(2);
  });

  it('keeps a version from history as the current text and clears the branch', async () => {
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
    fireEvent.click(rows[1]);
    fireEvent.click(screen.getByText('keep this version'));

    // Keeping is a normal snapshot on top of the head: history stays a line, nothing forks.
    await waitFor(async () => expect(await repo.getNote(id)).toMatchObject({ body: 'first' }));
    expect(await repo.heads(id)).toHaveLength(1);
    expect(await repo.versions(id)).toHaveLength(3);
  });

  it('flags a competing branch and dismisses it without touching the text', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'a');
    const root = (await repo.versions(id))[0];
    await repo.saveBody(id, 'b'); // head
    await repo.saveBody(id, 'c', root.id); // a second head from the same version
    expect(await repo.heads(id)).toHaveLength(2);

    renderWithRepo(() => <NoteView id={id} />, repo);

    const notice = await waitFor(() => screen.getByText(/other branch/));
    expect(notice.textContent).toContain('c');
    fireEvent.click(screen.getByText('dismiss'));

    await waitFor(() => expect(screen.queryByText(/other branch/)).toBeNull());
    const note = await repo.getNote(id);
    expect(JSON.parse(note!.acknowledged)).toHaveLength(1);
    expect(note!.body).toBe('c'); // dismissing is bookkeeping, not an edit
  });
});
