// A one-shot handshake: the list overlay arms it before switching notes, the view answers once
// its data is on screen, so the overlay closes on a ready view instead of a half-loaded one.
let pending: Promise<void> | null = null;
let resolvePending: (() => void) | null = null;

export function armViewReady(): Promise<void> {
  let resolve!: () => void;
  pending = new Promise<void>((r) => {
    resolve = r;
  });
  resolvePending = resolve;
  return pending;
}

export function signalViewReady(): void {
  resolvePending?.();
  pending = null;
  resolvePending = null;
}

export function waitForViewReady(): Promise<void> {
  return pending ?? Promise.resolve();
}
