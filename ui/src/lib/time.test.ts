import { createRoot } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { ago, useTicker } from './time';

const t0 = 1_000_000_000_000;

describe('ago', () => {
  const now = t0;

  it('is compact at every scale', () => {
    expect(ago(now - 5_000, now)).toBe('now');
    expect(ago(now - 90_000, now)).toBe('1m');
    expect(ago(now - 3 * 3600_000, now)).toBe('3h');
    expect(ago(now - 5 * 86400_000, now)).toBe('5d');
    expect(ago(now - 400 * 86400_000, now)).toBe('1y');
  });

  it('does not show negative time for clock skew', () => {
    expect(ago(now + 60_000, now)).toBe('now');
  });
});

describe('useTicker', () => {
  it('steps the clock of a relative stamp every ten seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    let clock!: () => number;
    const dispose = createRoot((dispose) => {
      clock = useTicker();
      return dispose;
    });

    expect(clock()).toBe(t0);
    expect(ago(t0 - 5_000, clock())).toBe('now');

    vi.advanceTimersByTime(10_000);
    expect(clock()).toBe(t0 + 10_000);
    expect(ago(t0 - 5_000, clock())).toBe('15s'); // the label moves on without a reload

    dispose();
    vi.useRealTimers();
  });
});
