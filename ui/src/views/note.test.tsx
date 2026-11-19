import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { testRepo } from '../db/inProcess';
import { renderWithRepo } from '../test-utils';
import NoteView from './NoteView';

describe('Note view', () => {
  it('saves the body on blur and keeps it visible', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    renderWithRepo(() => <NoteView id={id} />, repo);

    const editor = await screen.findByLabelText('note body');
    fireEvent.input(editor, { target: { value: '# Lab notes\nfirst try' } });
    fireEvent.blur(editor);

    const versions = await repo.versions(id);
    expect(versions).toHaveLength(1);
    expect(versions[0].body).toContain('first try');
    expect(await repo.getNote(id)).toMatchObject({ title: 'Lab notes' });
  });

  it('writes no extra version when the body did not change', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    renderWithRepo(() => <NoteView id={id} />, repo);

    const editor = await screen.findByLabelText('note body');
    fireEvent.input(editor, { target: { value: 'same' } });
    fireEvent.blur(editor);
    fireEvent.blur(editor);

    await waitFor(async () => expect(await repo.versions(id)).toHaveLength(1));
  });

  it('stores tags from the comma separated field', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    renderWithRepo(() => <NoteView id={id} />, repo);

    const tags = await screen.findByLabelText('tags');
    fireEvent.input(tags, { target: { value: ' Work, lab ,,' } });
    fireEvent.blur(tags);

    expect(await repo.tagsOf(id)).toEqual(['lab', 'work']);
  });

  it('shows versions and restores one', async () => {
    const repo = testRepo();
    const id = await repo.createNote('note');
    await repo.saveBody(id, 'first');
    await repo.saveBody(id, 'second');
    renderWithRepo(() => <NoteView id={id} />, repo);

    fireEvent.click(await screen.findByText('history'));
    const restores = await screen.findAllByText('restore');
    fireEvent.click(restores[restores.length - 1]);

    expect(await repo.getNote(id)).toMatchObject({ body: 'first' });
  });
});
