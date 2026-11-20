import type { Note, VersionHead } from '../db/types';

/** A version id as history shows it: stable across devices, because it is the id the writer minted. */
export const shortId = (id: string): string => id.replace(/-/g, '').slice(0, 7);

/** Head ids the user has acknowledged; a malformed column must not break a view. */
export function parseAcknowledged(note: Pick<Note, 'acknowledged'> | undefined): string[] {
  if (!note) return [];
  try {
    const value = JSON.parse(note.acknowledged);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Divergence the user has not dealt with: heads other than the current one (the newest by
 * lamport) that were never acknowledged. Acknowledged and closed branches stay in the tree.
 */
export function unacknowledgedHeads(heads: VersionHead[], acknowledged: string[]): VersionHead[] {
  return heads.slice(1).filter((head) => !acknowledged.includes(head.id));
}
