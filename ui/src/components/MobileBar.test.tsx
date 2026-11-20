import { fireEvent, render, screen } from '@solidjs/testing-library';
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
});
