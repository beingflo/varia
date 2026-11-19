const UNITS: [limit: number, div: number, label: string][] = [
  [60, 1, 's'],
  [3600, 60, 'm'],
  [86400, 3600, 'h'],
  [86400 * 30, 86400, 'd'],
  [86400 * 365, 86400 * 30, 'mo'],
  [Infinity, 86400 * 365, 'y'],
];

/** Compact age: "now", "3m", "2d". Display only — ordering never uses wall clocks. */
export function ago(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return 'now';
  const [, div, label] = UNITS.find(([limit]) => seconds < limit)!;
  return `${Math.floor(seconds / div)}${label}`;
}
