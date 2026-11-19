import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { testRepo } from '../db/inProcess';
import { renderWithRepo } from '../test-utils';
import TodoView from './TodoView';

describe('Todo view', () => {
  it('adds items with Enter', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const input = await screen.findByLabelText('new item');
    fireEvent.input(input, { target: { value: 'buy milk' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByDisplayValue('buy milk')).toBeTruthy();
    expect((await repo.items(id)).map((i) => i.text)).toEqual(['buy milk']);
  });

  it('hides checked items until show-done is on', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    await repo.addItem(id, 'one');
    await repo.addItem(id, 'two');
    renderWithRepo(() => <TodoView id={id} />, repo);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'one' }));
    expect(await screen.findByDisplayValue('two')).toBeTruthy();
    await waitFor(() => expect(screen.queryByDisplayValue('one')).toBeNull());

    fireEvent.click(screen.getByRole('checkbox', { name: /show done/i }));
    expect(await screen.findByDisplayValue('one')).toBeTruthy();
  });

  it('edits and deletes items', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo');
    await repo.addItem(id, 'typo');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const text = await screen.findByDisplayValue('typo');
    fireEvent.input(text, { target: { value: 'fixed' } });
    fireEvent.blur(text);
    expect((await repo.items(id))[0].text).toBe('fixed');

    fireEvent.click(await screen.findByLabelText('delete fixed'));
    expect(await repo.items(id)).toEqual([]);
  });

  it('renames the list', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const title = await screen.findByLabelText('list title');
    fireEvent.input(title, { target: { value: 'errands' } });
    fireEvent.blur(title);

    expect(await repo.getNote(id)).toMatchObject({ title: 'errands' });
  });
});
