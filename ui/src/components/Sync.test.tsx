import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { SyncProvider } from '../sync/context';
import type { Engine, SyncStatus } from '../sync/engine';
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
  const [enrolment, setEnrolment] = createSignal('');
  const engine = {
    status,
    enrolled,
    enrolment,
    start: vi.fn(),
    stop: vi.fn(),
    run: vi.fn(async () => setStatus({ ...status(), state: 'idle', last: Date.now() })),
    signup: vi.fn(async () => {
      setEnrolment(`varia1.tok.${'A'.repeat(52)}`);
      setEnrolled(true);
      return enrolment();
    }),
    enrol: vi.fn(async () => {
      setEnrolled(true);
      setStatus({ ...status(), state: 'idle', last: Date.now() });
    }),
    refreshPending: vi.fn(),
    unlink: vi.fn(async () => {
      setEnrolled(false);
      setEnrolment('');
    }),
    ...overrides,
  } as unknown as Engine;
  return { engine, setStatus, setEnrolled, setEnrolment };
}

const open = (engine: Engine) => render(() => <SyncProvider engine={engine}><Sync onClose={() => {}} /></SyncProvider>);

const joinButton = () => screen.getByRole('button', { name: 'join this device' });
const createButton = () => screen.getByRole('button', { name: 'create a new account' });

describe('sync overlay', () => {
  it('keeps the join button disabled until a code is entered, then enrols on Enter', async () => {
    const { engine } = fakeEngine();
    open(engine);

    expect(joinButton()).toHaveProperty('disabled', true);
    const input = screen.getByLabelText('enrolment code');
    fireEvent.input(input, { target: { value: 'varia1.abc.DEF' } });
    await waitFor(() => expect(joinButton()).toHaveProperty('disabled', false));
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(engine.enrol).toHaveBeenCalledWith('varia1.abc.DEF'));
    expect(engine.signup).not.toHaveBeenCalled();
  });

  it('enrols a pasted code from the primary button', async () => {
    const { engine } = fakeEngine();
    open(engine);

    fireEvent.input(screen.getByLabelText('enrolment code'), { target: { value: 'varia1.abc.XYZ' } });
    fireEvent.click(joinButton());

    await waitFor(() => expect(engine.enrol).toHaveBeenCalledWith('varia1.abc.XYZ'));
    expect(engine.signup).not.toHaveBeenCalled();
  });

  it('creates an account from its own button, whatever is in the field', async () => {
    const { engine } = fakeEngine();
    open(engine);

    fireEvent.input(screen.getByLabelText('enrolment code'), { target: { value: 'half typed' } });
    fireEvent.click(createButton());

    await waitFor(() => expect(engine.signup).toHaveBeenCalledTimes(1));
    expect(engine.enrol).not.toHaveBeenCalled();
  });

  it('keeps the enrolment code on screen instead of showing it once', async () => {
    const { engine } = fakeEngine();
    open(engine);

    fireEvent.click(createButton());
    const code = await screen.findByText(/^varia1\.tok\./);
    expect(code.textContent).toBe(`varia1.tok.${'A'.repeat(52)}`);
    expect(screen.getByRole('link').getAttribute('href')).toContain(encodeURIComponent(code.textContent!.trim()));
  });

  it('shows the code again on a later visit, from the stored root', async () => {
    const { engine, setEnrolled, setEnrolment } = fakeEngine();
    setEnrolled(true);
    setEnrolment(`varia1.tok.${'B'.repeat(52)}`);
    open(engine);

    expect(await screen.findByText(`varia1.tok.${'B'.repeat(52)}`)).toBeTruthy();
  });

  it('shows the state of the last sync and syncs on Enter', async () => {
    const { engine, setEnrolled } = fakeEngine({}, { state: 'idle', last: Date.now(), pending: 3 });
    setEnrolled(true);
    open(engine);

    await waitFor(() => expect(engine.run).toHaveBeenCalled()); // opening the panel syncs
    expect(await screen.findByText(/synced now · 3 pending/)).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(engine.run).toHaveBeenCalledTimes(2));
  });

  it('unlinks in two steps, so the only copy of the root is not lost by a stray click', async () => {
    const { engine, setEnrolled } = fakeEngine();
    setEnrolled(true);
    open(engine);

    const button = await screen.findByRole('button', { name: 'unlink this device' });
    fireEvent.click(button);
    expect(engine.unlink).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'click again to unlink' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'click again to unlink' }));
    await waitFor(() => expect(engine.unlink).toHaveBeenCalledTimes(1));
    // Back to the not-enrolled form, with the notes untouched.
    expect(await screen.findByRole('button', { name: 'join this device' })).toBeTruthy();
  });

  it('reports a failed sync with its reason', async () => {
    const { engine, setEnrolled } = fakeEngine({ run: vi.fn() }, { state: 'error', error: '429 rate_limited' });
    setEnrolled(true);
    open(engine);

    expect(await screen.findByText(/sync failed — 429 rate_limited/)).toBeTruthy();
  });
});
