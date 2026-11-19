import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { Engine, SyncStatus } from '../sync/engine';
import { SyncProvider } from '../sync/context';
import Sync from './Sync';

/** A stand-in for the real engine: the view is what is under test here. */
function fakeEngine(overrides: Partial<Engine> = {}, initial: Partial<SyncStatus> = {}) {
  const [status, setStatus] = createSignal<SyncStatus>({
    state: 'off',
    pending: 0,
    last: 0,
    usage: 0,
    cap: 0,
    error: '',
    ...initial,
  });
  const [enrolled, setEnrolled] = createSignal(false);
  const engine = {
    status,
    enrolled,
    start: vi.fn(),
    stop: vi.fn(),
    run: vi.fn(async () => setStatus({ ...status(), state: 'idle', last: Date.now() })),
    signup: vi.fn(async () => 'varia1.tok.' + 'A'.repeat(52)),
    enrol: vi.fn(async () => {
      setEnrolled(true);
      setStatus({ ...status(), state: 'idle', last: Date.now() });
    }),
    refreshPending: vi.fn(),
    ...overrides,
  } as unknown as Engine;
  return { engine, setStatus, setEnrolled };
}

const open = (engine: Engine) => render(() => <SyncProvider engine={engine}><Sync onClose={() => {}} /></SyncProvider>);

describe('sync overlay', () => {
  it('enrols with a pasted code', async () => {
    const { engine } = fakeEngine();
    open(engine);

    const input = screen.getByLabelText('enrolment code') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'varia1.abc.DEF' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(engine.enrol).toHaveBeenCalledWith('varia1.abc.DEF'));
  });

  it('does not create an account on a plain Enter, only on cmd+Enter', async () => {
    const { engine } = fakeEngine();
    open(engine);

    const input = screen.getByLabelText('enrolment code');
    fireEvent.keyDown(input, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.signup).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(engine.signup).toHaveBeenCalledTimes(1));
  });

  it('enrols rather than signing up when a code is pasted, whichever Enter is used', async () => {
    const { engine } = fakeEngine();
    open(engine);

    const input = screen.getByLabelText('enrolment code');
    fireEvent.input(input, { target: { value: 'varia1.abc.DEF' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(engine.enrol).toHaveBeenCalledWith('varia1.abc.DEF'));
    expect(engine.signup).not.toHaveBeenCalled();
  });

  it('keeps the new enrolment code on screen after the account exists', async () => {
    const { engine } = fakeEngine();
    open(engine);

    fireEvent.keyDown(screen.getByLabelText('enrolment code'), { key: 'Enter', metaKey: true });

    const code = await screen.findByText(/^varia1\.tok\./);
    expect(code.textContent).toHaveLength('varia1.tok.'.length + 52);
    expect(screen.getByText('download')).toBeTruthy();
    // Enrolment flips the engine's state, and the code must not disappear with it.
    expect(screen.getByRole('link').getAttribute('href')).toContain(encodeURIComponent(code.textContent!.trim()));
  });

  it('shows the state of the last sync and syncs on Enter', async () => {
    const { engine, setEnrolled, setStatus } = fakeEngine({}, { state: 'idle', last: Date.now(), pending: 3 });
    setEnrolled(true);
    open(engine);

    await waitFor(() => expect(engine.run).toHaveBeenCalled()); // opening the panel syncs
    expect(await screen.findByText(/synced now · 3 pending/)).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(engine.run).toHaveBeenCalledTimes(2));
  });

  it('reports a failed sync with its reason', async () => {
    const { engine, setEnrolled, setStatus } = fakeEngine({ run: vi.fn() }, { state: 'error', error: '429 rate_limited' });
    setEnrolled(true);
    open(engine);

    expect(await screen.findByText(/sync failed — 429 rate_limited/)).toBeTruthy();
  });
});
