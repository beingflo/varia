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

  // Enter on the last row hands the caret to the placeholder, which already sits below the list:
  // creating a blank item there would show two empty rows, one with a real bullet.
  it('moves the caret into the placeholder after enter on the last item, at its depth', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    await repo.addItem(id, 'parent');
    await repo.addItem(id, 'nested', undefined, 1);
    renderWithRepo(() => <TodoView id={id} />, repo);

    const nested = await screen.findByDisplayValue('nested');
    nested.focus();
    fireEvent.keyDown(nested, { key: 'Enter' });

    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('new item')));
    expect((document.querySelector('.item-add') as HTMLElement).style.paddingLeft).toBe('1.4rem');
    expect(await items(repo, id)).toHaveLength(2); // nothing blank was written

    // Typing there appends at the level the item had.
    const add = screen.getByLabelText('new item') as HTMLInputElement;
    fireEvent.input(add, { target: { value: 'sibling' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    await waitFor(async () => {
      const list = await items(repo, id);
      expect(list.map((item) => [item.text, item.depth])).toEqual([
        ['parent', 0],
        ['nested', 1],
        ['sibling', 1],
      ]);
    });
  });

  // What is typed lives in state, not in the input: a reload underneath must not drop it.
  it('keeps what was typed into a row while another row changes', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    await repo.addItem(id, 'one');
    await repo.addItem(id, 'two');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const one = (await screen.findByDisplayValue('one')) as HTMLInputElement;
    one.focus();
    fireEvent.input(one, { target: { value: 'one, edited' } });

    // Checking off the other row reloads the list: the row being edited is rebuilt from it.
    fireEvent.click(screen.getByDisplayValue('two'), { metaKey: true });
    runCommand('toggle-done'); // and stays visible, so the assertion is about text only
    await waitFor(() => expect(screen.getByDisplayValue('one, edited')).toBeTruthy());

    fireEvent.blur(screen.getByDisplayValue('one, edited'));
    await waitFor(async () =>
      expect((await items(repo, id)).map((item) => item.text)).toEqual(['one, edited', 'two']),
    );
  });

  it('keeps what was typed into a new row when tab indents it', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    await repo.addItem(id, 'one');
    await repo.addItem(id, 'two');
    renderWithRepo(() => <TodoView id={id} />, repo);

    // A row in the middle, so Enter inserts an item instead of moving to the placeholder.
    const first = await screen.findByDisplayValue('one');
    first.focus();
    fireEvent.keyDown(first, { key: 'Enter' });

    const typed = (await screen.findByLabelText('empty item')) as HTMLInputElement;
    fireEvent.input(typed, { target: { value: 'typed then indented' } });
    fireEvent.keyDown(typed, { key: 'Tab' });

    // The text is written before the row is rebuilt for the new depth.
    await waitFor(async () =>
      expect((await items(repo, id)).map((item) => [item.text, item.depth])).toEqual([
        ['one', 0],
        ['typed then indented', 1],
        ['two', 0],
      ]),
    );
    expect((screen.getByDisplayValue('typed then indented') as HTMLInputElement).value).toBe('typed then indented');
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

  it('saves the half-typed new item with the save command, like enter would', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const add = await screen.findByLabelText('new item');
    add.focus();
    fireEvent.input(add, { target: { value: 'bought' } });
    runCommand('save'); // no blur: the field keeps focus, so ⌘S has to commit it itself

    await waitFor(async () => expect((await items(repo, id)).map((item) => item.text)).toEqual(['bought']));
    await waitFor(() => expect((screen.getByLabelText('new item') as HTMLInputElement).value).toBe(''));
  });

  it('creates exactly one note when a title save and an item race for it', async () => {
    const repo = testRepo();
    renderWithRepo(() => <TodoView />, repo);

    const title = screen.getByLabelText('list title');
    fireEvent.input(title, { target: { value: 'work' } });
    runCommand('save'); // starts creating the note
    const add = screen.getByLabelText('new item') as HTMLInputElement;
    fireEvent.input(add, { target: { value: 'first item' } });
    fireEvent.keyDown(add, { key: 'Enter' }); // and a second write before that create landed

    await waitFor(async () => expect(await repo.listNotes()).toHaveLength(1));
    const [note] = await repo.listNotes();
    expect(note.title).toBe('work');
    expect((await items(repo, note.id)).map((item) => item.text)).toEqual(['first item']);
  });

  it('shows one empty row at most: enter on the last item leaves the placeholder to be typed in', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    await repo.addItem(id, 'one');
    renderWithRepo(() => <TodoView id={id} />, repo);

    const first = await screen.findByDisplayValue('one');
    first.focus();
    fireEvent.keyDown(first, { key: 'Enter' });

    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('new item')));
    expect(document.querySelectorAll('.item-text')).toHaveLength(1); // no blank item row
    expect(await items(repo, id)).toHaveLength(1);
  });

  it('drops an abandoned empty row when another item is added', async () => {
    const repo = testRepo();
    const id = await repo.createNote('todo', 'work');
    await repo.addItem(id, 'one');
    await repo.addItem(id, 'two');
    renderWithRepo(() => <TodoView id={id} />, repo);

    // Enter in the middle does create a row: there is no placeholder to carry the caret there.
    const first = await screen.findByDisplayValue('one');
    first.focus();
    fireEvent.keyDown(first, { key: 'Enter' });
    await waitFor(async () => expect(await items(repo, id)).toHaveLength(3));

    // Left blank: adding from the field drops it rather than parking a blank row between items.
    const add = screen.getByLabelText('new item');
    add.focus();
    fireEvent.input(add, { target: { value: 'three' } });
    fireEvent.keyDown(add, { key: 'Enter' });

    await waitFor(async () => expect((await items(repo, id)).map((item) => item.text)).toEqual(['one', 'two', 'three']));
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
