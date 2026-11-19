import { describe, expect, it } from 'vitest';
import { ago } from './time';

describe('ago', () => {
  const now = 1_000_000_000_000;

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
