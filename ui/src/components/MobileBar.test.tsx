import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { onCommand } from '../lib/commands';
import MobileBar from './MobileBar';

describe('Mobile bar', () => {
  it('runs the command a button stands for', () => {
    const list = vi.fn();
    const off = onCommand('list', list);
    render(() => <MobileBar kind="note" />);

    fireEvent.click(screen.getByText('notes'));

    expect(list).toHaveBeenCalledTimes(1);
    off();
  });

  it('offers the done toggle instead of versions on a list', () => {
    const done = vi.fn();
    const off = onCommand('toggle-done', done);
    render(() => <MobileBar kind="todo" />);

    expect(screen.queryByText('versions')).toBeNull();
    fireEvent.click(screen.getByText('done'));

    expect(done).toHaveBeenCalledTimes(1);
    off();
  });

  it('gives a stream a save button, since ⌘S has no finger', async () => {
    const save = vi.fn();
    // A save is the flush broadcast first, then the views that react to it having happened.
    const off = onCommand('save', save);
    render(() => <MobileBar kind="tag" />);

    fireEvent.click(screen.getByText('save'));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    off();
  });
});
