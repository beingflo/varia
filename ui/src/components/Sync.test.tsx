import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { SyncProvider } from '../sync/context';
import type { Engine, SyncStatus } from '../sync/engine';
import Sync from './Sync';

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const KEY = 'A'.repeat(52);

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
  const [token, setToken] = createSignal('');
  const engine = {
    status,
    enrolled,
    token,
    start: vi.fn(),
    stop: vi.fn(),
    run: vi.fn(async () => setStatus({ ...status(), state: 'idle', last: Date.now() })),
    signup: vi.fn(async () => {
      setToken(TOKEN);
      setEnrolled(true);
      return { token: TOKEN, key: KEY };
    }),
    enrol: vi.fn(async (given: string) => {
      setToken(given);
      setEnrolled(true);
      setStatus({ ...status(), state: 'idle', last: Date.now() });
    }),
    unlink: vi.fn(async () => {
      setEnrolled(false);
      setToken('');
    }),
    refreshPending: vi.fn(),
    ...overrides,
  } as unknown as Engine;
  return { engine, setStatus, setEnrolled, setToken };
}

const open = (engine: Engine) => render(() => <SyncProvider engine={engine}><Sync onClose={() => {}} /></SyncProvider>);

const joinButton = () => screen.getByRole('button', { name: 'join this device' });
const createButton = () => screen.getByRole('button', { name: 'create a new account' });

describe('sync overlay', () => {
  it('keeps join disabled until both secrets are pasted, then enrols', async () => {
    const { engine } = fakeEngine();
    open(engine);

    expect(joinButton()).toHaveProperty('disabled', true);
    fireEvent.input(screen.getByLabelText('account token'), { target: { value: TOKEN } });
    await waitFor(() => expect(joinButton()).toHaveProperty('disabled', true)); // key still missing

    const key = screen.getByLabelText('account key');
    fireEvent.input(key, { target: { value: KEY } });
    await waitFor(() => expect(joinButton()).toHaveProperty('disabled', false));
    fireEvent.keyDown(key, { key: 'Enter' });

    await waitFor(() => expect(engine.enrol).toHaveBeenCalledWith(TOKEN, KEY));
    expect(engine.signup).not.toHaveBeenCalled();
  });

  it('shows token and key separately after signup, and never the key again', async () => {
    const { engine } = fakeEngine();
    open(engine);

    fireEvent.click(createButton());
    await waitFor(() => expect(engine.signup).toHaveBeenCalledTimes(1));

    expect(await screen.findByText(TOKEN)).toBeTruthy();
    expect(screen.getByText(KEY)).toBeTruthy();
    expect(screen.getByText(/only place the key will ever be shown/)).toBeTruthy();
    expect(screen.getByText(/Losing it loses every note/)).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toContain(encodeURIComponent(KEY));

    // Dismissing the key view leaves the enrolled view, which shows the token only.
    fireEvent.click(screen.getByRole('button', { name: 'I have saved the key' }));
    await waitFor(() => expect(screen.queryByText(KEY)).toBeNull());
    expect(screen.getByText(TOKEN)).toBeTruthy();
  });

  it('returns to the form after unlinking, in two steps', async () => {
    const { engine, setEnrolled, setToken } = fakeEngine();
    setEnrolled(true);
    setToken(TOKEN);
    open(engine);

    fireEvent.click(await screen.findByRole('button', { name: 'unlink this device' }));
    expect(engine.unlink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'click again to unlink' }));

    await waitFor(() => expect(engine.unlink).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'join this device' })).toBeTruthy();
  });

  it('reports the last sync and syncs again on Enter', async () => {
    const { engine, setEnrolled } = fakeEngine({}, { state: 'idle', last: Date.now(), pending: 3 });
    setEnrolled(true);
    open(engine);

    await waitFor(() => expect(engine.run).toHaveBeenCalled());
    expect(await screen.findByText(/synced now · 3 pending/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(engine.run).toHaveBeenCalledTimes(2));
  });

  it('reports a failed sync with its reason', async () => {
    const { engine, setEnrolled } = fakeEngine({ run: vi.fn() }, { state: 'error', error: '429 rate_limited' });
    setEnrolled(true);
    open(engine);

    expect(await screen.findByText(/sync failed — 429 rate_limited/)).toBeTruthy();
  });
});
