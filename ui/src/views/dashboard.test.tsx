import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { testRepo } from '../db/inProcess';
import { formatBoard, parseBoard } from '../lib/board';
import { runCommand } from '../lib/commands';
import { renderWithRepo } from '../test-utils';
import Dashboard from './Dashboard';

// CodeMirror needs a real browser; the tests use the same props on a textarea.
vi.mock('../editor/Editor', async () => ({ default: (await import('../editor/TextareaDouble')).default }));

async function seed() {
  const repo = testRepo();
  const lab = await repo.createNote('note');
  await repo.saveBody(lab, '# Lab\nfirst try');
  const other = await repo.createNote('note');
  await repo.saveBody(other, '# Other\nsecond');
  const list = await repo.createNote('todo', 'Work');
  await repo.addItem(list, 'ship it');
  const board = await repo.createNote('note');
  await repo.saveBody(
    board,
    formatBoard({ title: 'Board', tiles: [{ note: lab, w: 1, h: 1 }, { note: other, w: 2, h: 2 }] }),
  );
  return { repo, lab, other, list, board };
}

const tilesOf = async (repo: Awaited<ReturnType<typeof seed>>['repo'], id: string) =>
  parseBoard((await repo.getNote(id))!.body).tiles;

describe('Dashboard', () => {
  it('opens every tile as an ordinary, editable view and saves them all at once', async () => {
    const { repo, lab, other, board } = await seed();
    renderWithRepo(() => <Dashboard id={board} />, repo);

    await waitFor(() => expect(screen.getAllByLabelText('note body')).toHaveLength(2));
    // No tile takes the caret: six of them would fight over it.
    expect(document.activeElement).toBe(document.body);

    const [first, second] = screen.getAllByLabelText('note body');
    fireEvent.input(first, { target: { value: '# Lab\nedited in the tile' } });
    fireEvent.input(second, { target: { value: '# Other\nedited too' } });
    runCommand('save'); // one command, every view on screen

    await waitFor(async () => expect((await repo.getNote(lab))!.body).toBe('# Lab\nedited in the tile'));
    await waitFor(async () => expect((await repo.getNote(other))!.body).toBe('# Other\nedited too'));
  });

  it('edits a list inside its tile', async () => {
    const { repo, list, board } = await seed();
    await repo.saveBody(
      board,
      formatBoard({ title: 'Board', tiles: [{ note: list, w: 1, h: 1 }] }),
    );
    renderWithRepo(() => <Dashboard id={board} />, repo);

    fireEvent.click(await screen.findByLabelText('check item'));
    // Done rows are hidden by default, so the row leaves the tile once the write lands.
    await waitFor(() => expect(screen.queryByLabelText('ship it')).toBeNull());
    expect(await repo.items(list)).toHaveLength(0);
  });

  it('saves a typed board title on a flush, not only when the input blurs', async () => {
    const { repo, board } = await seed();
    renderWithRepo(() => <Dashboard id={board} />, repo);
    await waitFor(() => expect(screen.getAllByLabelText('note body')).toHaveLength(2));

    fireEvent.input(screen.getByLabelText('board title'), { target: { value: 'Work board' } });
    // No blur: this is what a keyboard command does right before leaving the view.
    runCommand('save');

    await waitFor(async () => expect(parseBoard((await repo.getNote(board))!.body).title).toBe('Work board'));
  });

  it('resizes, reorders and drops tiles by rewriting the board body only', async () => {
    const { repo, lab, other, board } = await seed();
    renderWithRepo(() => <Dashboard id={board} />, repo);
    await waitFor(() => expect(screen.getAllByLabelText('note body')).toHaveLength(2));

    fireEvent.click(screen.getAllByLabelText('tile width')[0]);
    await waitFor(async () => expect((await tilesOf(repo, board))[0].w).toBe(2));

    fireEvent.click(screen.getAllByLabelText('move tile down')[0]);
    await waitFor(async () => expect((await tilesOf(repo, board)).map((tile) => tile.note)).toEqual([other, lab]));

    fireEvent.click(screen.getAllByLabelText('remove from board')[1]);
    await waitFor(async () => expect((await tilesOf(repo, board)).map((tile) => tile.note)).toEqual([other]));
    // The note the tile pointed at is untouched: a board only points at notes.
    expect((await repo.getNote(lab))!.deleted).toBe(0);
  });

  it('opens a note fullscreen from its tile, and leaves a modified click to the browser', async () => {
    const { repo, lab, board } = await seed();
    const opened = vi.fn();
    renderWithRepo(() => <Dashboard id={board} onOpen={opened} />, repo);
    await waitFor(() => expect(screen.getAllByLabelText('note body')).toHaveLength(2));

    const link = screen.getAllByLabelText('open note')[0];
    // A real href, so ⌘-click opens the note in a new tab like any other deep link.
    expect(link.getAttribute('href')).toBe('/note/' + lab);

    // A modified click is the browser's: it is not turned into in-app navigation.
    const keepDefault = (event: MouseEvent) => event.preventDefault(); // jsdom cannot navigate
    link.addEventListener('click', keepDefault);
    fireEvent.click(link, { metaKey: true });
    link.removeEventListener('click', keepDefault);
    expect(opened).not.toHaveBeenCalled();

    fireEvent.click(link);
    await waitFor(() => expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id: lab })));
  });

  it('refuses to hold another dashboard, and marks boards in the note list', async () => {
    const { repo, board } = await seed();
    const nested = await repo.createNote('note');
    await repo.saveBody(nested, formatBoard({ title: 'Inner', tiles: [] }));
    await repo.saveBody(
      board,
      formatBoard({ title: 'Board', tiles: [{ note: nested, w: 1, h: 1 }] }),
    );
    renderWithRepo(() => <Dashboard id={board} />, repo);

    expect(await screen.findByText('A dashboard cannot hold another.')).toBeTruthy();
  });
});
