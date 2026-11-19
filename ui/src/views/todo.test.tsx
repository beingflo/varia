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

  it('hides checked items until the toggle-done command runs', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    const one = await repo.addItem(id, 'one');
    await repo.addItem(id, 'two');
    renderWithRepo(() => <TodoView id={id} />, repo);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'one' }));
    await waitFor(() => expect(screen.queryByDisplayValue('one')).toBeNull());

    runCommand('toggle-done');
    expect(await screen.findByDisplayValue('one')).toBeTruthy();
    runCommand('toggle-done');
    await waitFor(() => expect(screen.queryByDisplayValue('one')).toBeNull());
    expect(await repo.items(id, true)).toHaveLength(2);
    expect(one).toBeTruthy();
  });

  it('edits item text and deletes an item by emptying it', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo');
    await repo.addItem(id, 'typo');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const text = await screen.findByRole('textbox', { name: 'typo' });
    fireEvent.input(text, { target: { value: 'fixed' } });
    fireEvent.blur(text);
    await waitFor(async () => expect((await repo.items(id))[0].text).toBe('fixed'));

    const again = await screen.findByRole('textbox', { name: 'fixed' });
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

  it('refuses to blank the title', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const title = await screen.findByLabelText('list title');
    fireEvent.input(title, { target: { value: '' } });
    fireEvent.blur(title);

    await new Promise((r) => setTimeout(r, 20));
    expect(await repo.getNote(id)).toMatchObject({ title: 'work' });
  });
});
