import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { testRepo } from '../db/inProcess';
import { runCommand } from '../lib/commands';
import { renderWithRepo } from '../test-utils';
import TodoView from './TodoView';

const items = (repo: ReturnType<typeof testRepo>, id: string) => repo.items(id, true);

describe('Todo view', () => {
  it('adds items from the add field', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const add = await screen.findByLabelText('new item');
    fireEvent.input(add, { target: { value: 'buy milk' } });
    fireEvent.keyDown(add, { key: 'Enter' });

    await waitFor(async () => expect((await items(repo, id)).map((i) => i.text)).toEqual(['buy milk']));
    expect(await screen.findByDisplayValue('buy milk')).toBeTruthy();
  });

  it('indents the pending item with tab in the add field', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    await repo.addItem(id, 'parent');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const add = await screen.findByLabelText('new item');
    await screen.findByDisplayValue('parent'); // the list is loaded before indenting
    fireEvent.keyDown(add, { key: 'Tab' });
    fireEvent.input(add, { target: { value: 'child' } });
    fireEvent.keyDown(add, { key: 'Enter' });

    await waitFor(async () => {
      const list = await items(repo, id);
      expect(list.map((i) => `${i.text}@${i.depth}`)).toEqual(['parent@0', 'child@1']);
    });

    // The indent level is remembered: the next item lands at the same depth.
    const again = screen.getByLabelText('new item');
    fireEvent.input(again, { target: { value: 'sibling' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    await waitFor(async () => expect((await items(repo, id))[2]).toMatchObject({ text: 'sibling', depth: 1 }));

    // Enter on an empty field steps the pending item back out one level, without adding anything.
    fireEvent.keyDown(screen.getByLabelText('new item'), { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('.item-add')).toHaveProperty('style.paddingLeft', '0rem'));
    expect(await items(repo, id)).toHaveLength(3);
  });

  it('checks an item off with cmd+click, never with a plain click', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    await repo.addItem(id, 'milk');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const input = await screen.findByDisplayValue('milk');
    fireEvent.click(input);
    await new Promise((r) => setTimeout(r, 20));
    expect((await items(repo, id))[0].done).toBe(0);

    fireEvent.click(input, { metaKey: true });
    await waitFor(async () => expect((await items(repo, id))[0].done).toBe(1));
  });

  it('hides checked items until the toggle-done command runs', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    await repo.addItem(id, 'one');
    await repo.addItem(id, 'two');
    renderWithRepo(() => <TodoView id={id} />, repo);

    fireEvent.click(await screen.findByDisplayValue('one'), { metaKey: true });
    await waitFor(() => expect(screen.queryByDisplayValue('one')).toBeNull());

    runCommand('toggle-done');
    expect(await screen.findByDisplayValue('one')).toBeTruthy();
  });

  it('refuses to check off a parent whose nested items are open, and flashes a tilde', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    const parent = await repo.addItem(id, 'parent');
    await repo.addItem(id, 'child', undefined, 1);
    renderWithRepo(() => <TodoView id={id} />, repo);

    fireEvent.click(await screen.findByDisplayValue('parent'), { metaKey: true });
    expect(await screen.findByText('~')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect((await items(repo, id)).find((i) => i.id === parent)!.done).toBe(0);
  });

  it('indents with tab and outdents with shift+tab', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    await repo.addItem(id, 'first');
    await repo.addItem(id, 'second');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const second = await screen.findByDisplayValue('second');
    fireEvent.keyDown(second, { key: 'Tab' });
    await waitFor(async () => expect((await items(repo, id))[1].depth).toBe(1));

    fireEvent.keyDown(screen.getByDisplayValue('second'), { key: 'Tab', shiftKey: true });
    await waitFor(async () => expect((await items(repo, id))[1].depth).toBe(0));
  });

  it('inserts a sibling after enter on a nested item', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    const parent = await repo.addItem(id, 'parent');
    await repo.addItem(id, 'nested', undefined, 1);
    renderWithRepo(() => <TodoView id={id} />, repo);

    const nested = await screen.findByDisplayValue('nested');
    fireEvent.keyDown(nested, { key: 'Enter' });

    await waitFor(async () => {
      const list = await items(repo, id);
      expect(list).toHaveLength(3);
      expect(list[2].depth).toBe(1);
      expect(list[2].text).toBe('');
      expect(list[0].id).toBe(parent);
    });
  });

  it('removes an empty item on backspace and puts the caret on the item above', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    await repo.addItem(id, 'one');
    await repo.addItem(id, 'two');
    await repo.addItem(id, '');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const empty = await screen.findByLabelText('empty item');
    empty.focus();
    fireEvent.keyDown(empty, { key: 'Backspace' });

    await waitFor(async () => expect((await items(repo, id)).map((i) => i.text)).toEqual(['one', 'two']));
    expect(document.activeElement).toBe(screen.getByDisplayValue('two'));
  });

  it('saves the focused item with the save command, without blurring it', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    await repo.addItem(id, 'draft');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const input = await screen.findByDisplayValue('draft');
    input.focus();
    fireEvent.input(input, { target: { value: 'draft saved' } });
    runCommand('save');

    await waitFor(async () => expect((await items(repo, id))[0].text).toBe('draft saved'));
    // Still editing: focus is restored to the (re-rendered) row, caret at the end.
    expect(document.activeElement).toBe(screen.getByDisplayValue('draft saved'));
  });

  it('goes one level up when enter is pressed on an empty nested item', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    await repo.addItem(id, 'parent');
    await repo.addItem(id, '', undefined, 1);
    renderWithRepo(() => <TodoView id={id} />, repo);

    const empty = await screen.findByLabelText('empty item');
    fireEvent.keyDown(empty, { key: 'Enter' });

    await waitFor(async () => {
      const list = await items(repo, id);
      expect(list[1].depth).toBe(0);
      expect(list).toHaveLength(2); // stepped up, nothing new inserted
    });
  });

  it('deletes an item by emptying it', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo');
    await repo.addItem(id, 'typo');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const input = await screen.findByDisplayValue('typo');
    fireEvent.input(input, { target: { value: '' } });
    fireEvent.blur(input);

    await waitFor(async () => expect(await items(repo, id)).toEqual([]));
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
