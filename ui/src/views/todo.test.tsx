import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { testRepo } from '../db/inProcess';
import { runCommand } from '../lib/commands';
import { renderWithRepo } from '../test-utils';
import TodoView from './TodoView';

describe('Todo view', () => {
  it('adds items with Enter and with blur', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const add = await screen.findByLabelText('new item');
    fireEvent.input(add, { target: { value: 'enter item' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    await waitFor(async () => expect((await repo.items(id)).map((i) => i.text)).toEqual(['enter item']));

    const again = screen.getByLabelText('new item');
    fireEvent.input(again, { target: { value: 'blur item' } });
    fireEvent.blur(again);
    await waitFor(async () => expect((await repo.items(id)).map((i) => i.text)).toEqual(['enter item', 'blur item']));
  });

  it('adds the row and clears the field in a single commit', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo');
    // Slow the follow-up note read: with two separate commits, the row would appear while the
    // field still shows the text.
    const slow = {
      ...repo,
      getNote: async (noteId: string) => {
        await new Promise((r) => setTimeout(r, 40));
        return repo.getNote(noteId);
      },
    };
    renderWithRepo(() => <TodoView id={id} />, slow);

    const add = await screen.findByLabelText('new item');
    fireEvent.input(add, { target: { value: 'fresh' } });
    fireEvent.keyDown(add, { key: 'Enter' });

    await new Promise((r) => setTimeout(r, 15));
    const rowPresent = screen.queryByRole('button', { name: 'fresh' }) !== null;
    const fieldFilled = (screen.getByLabelText('new item') as HTMLInputElement).value !== '';
    expect(rowPresent && fieldFilled).toBe(false);
  });

  it('checks an item off on screen before the write finishes', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo');
    await repo.addItem(id, 'slow toggle');
    let release: () => void = () => {};
    const slow = {
      ...repo,
      toggleItem: async (itemId: string) => {
        await new Promise<void>((r) => (release = r));
        return repo.toggleItem(itemId);
      },
    };
    renderWithRepo(() => <TodoView id={id} />, slow);

    fireEvent.click(await screen.findByRole('button', { name: 'slow toggle' }));
    await waitFor(() => expect(screen.queryByText('slow toggle')).toBeNull());
    release();
  });

  it('hides checked items until the toggle-done command runs', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    const one = await repo.addItem(id, 'one');
    await repo.addItem(id, 'two');
    renderWithRepo(() => <TodoView id={id} />, repo);

    // The whole row toggles: no checkbox.
    fireEvent.click(await screen.findByRole('button', { name: 'one' }));
    await waitFor(() => expect(screen.queryByText('one')).toBeNull());

    runCommand('toggle-done');
    expect(await screen.findByRole('button', { name: 'one' })).toBeTruthy();
    runCommand('toggle-done');
    await waitFor(() => expect(screen.queryByText('one')).toBeNull());
    expect(await repo.items(id, true)).toHaveLength(2);
    expect(one).toBeTruthy();
  });

  it('edits an item through the Edit button and deletes it by emptying it', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo');
    await repo.addItem(id, 'typo');
    renderWithRepo(() => <TodoView id={id} />, repo);

    fireEvent.click(await screen.findByRole('button', { name: 'edit typo' }));
    const text = await screen.findByRole('textbox', { name: 'edit item' });
    fireEvent.input(text, { target: { value: 'fixed' } });
    fireEvent.blur(text);
    await waitFor(async () => expect((await repo.items(id))[0].text).toBe('fixed'));

    fireEvent.click(await screen.findByRole('button', { name: 'edit fixed' }));
    const again = await screen.findByRole('textbox', { name: 'edit item' });
    fireEvent.input(again, { target: { value: '  ' } });
    fireEvent.blur(again);
    await waitFor(async () => expect(await repo.items(id)).toEqual([]));
  });

  it('renames the list on blur and on save', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const title = await screen.findByLabelText('list title');
    fireEvent.input(title, { target: { value: 'errands' } });
    fireEvent.blur(title);
    await waitFor(async () => expect(await repo.getNote(id)).toMatchObject({ title: 'errands' }));

    fireEvent.input(title, { target: { value: 'errands 2' } });
    runCommand('save');
    await waitFor(async () => expect(await repo.getNote(id)).toMatchObject({ title: 'errands 2' }));
  });

  it('starts a new list untitled, with a placeholder', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const title = await screen.findByLabelText('list title');
    expect(title).toHaveProperty('value', '');
    expect(title.getAttribute('placeholder')).toBe('Untitled list');
  });

  it('allows blanking the title of an existing list', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const title = await screen.findByLabelText('list title');
    fireEvent.input(title, { target: { value: '' } });
    fireEvent.blur(title);

    await waitFor(async () => expect(await repo.getNote(id)).toMatchObject({ title: '' }));
  });
});
