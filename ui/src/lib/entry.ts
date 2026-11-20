const KEY = 'varia:entered';

/** Storage can refuse (blocked cookies, some private modes): the landing then simply shows again. */
export function hasEntered(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function markEntered(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // Ignored: a device that refuses the flag still works, it just opens the landing every time.
  }
}
