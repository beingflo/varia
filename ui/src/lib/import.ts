// The only file the one-off importer accepts: what `convert-notes.mjs` writes.
//   {"count": 750, "notes": [{"oldId": 1075, "createdAt": "…", "modifiedAt": "…", "body": "## …"}]}
// `oldId` is the old database's note id; it becomes the varia note id, so importing a file twice
// cannot create a second copy (the repo refuses an id it already has).
import type { ImportedNote } from '../db/types';

/** The repo refuses a payload over this, so a bigger body could never sync. */
const MAX_BODY = 4_500_000;

const isStamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

const isOldId = (value: unknown): value is number | string =>
  typeof value === 'number' ||
  (typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value));

export function parseImportFile(text: string): ImportedNote[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('that file is not valid JSON');
  }
  const notes = (data as { notes?: unknown } | null)?.notes;
  if (!Array.isArray(notes)) throw new Error('expected a JSON object with a "notes" array');
  if (notes.length === 0) throw new Error('that file holds no notes');

  const problems: string[] = [];
  const seen = new Set<string>();
  const parsed: ImportedNote[] = [];

  notes.forEach((raw: unknown, index) => {
    const at = `note ${index + 1}`;
    if (typeof raw !== 'object' || raw === null) return problems.push(`${at}: not an object`);
    const note = raw as Record<string, unknown>;
    if (!isOldId(note.oldId)) return problems.push(`${at}: oldId must be a number or a plain string`);
    const id = `fn-${note.oldId}`;
    if (seen.has(id)) return problems.push(`${at}: oldId ${note.oldId} appears twice`);
    seen.add(id);
    if (!isStamp(note.createdAt)) return problems.push(`${at}: createdAt must be an ISO date`);
    if (!isStamp(note.modifiedAt)) return problems.push(`${at}: modifiedAt must be an ISO date`);
    if (typeof note.body !== 'string') return problems.push(`${at}: body must be a string`);
    if (note.body.length > MAX_BODY) {
      return problems.push(`${at}: body is over ${MAX_BODY} characters and could never sync`);
    }
    parsed.push({
      id,
      createdAt: Date.parse(note.createdAt),
      modifiedAt: Date.parse(note.modifiedAt),
      body: note.body,
    });
  });

  if (problems.length) {
    const more = problems.length > 5 ? `\n… and ${problems.length - 5} more` : '';
    throw new Error(
      `${problems.length} problem${problems.length === 1 ? '' : 's'} in the file:\n${problems.slice(0, 5).join('\n')}${more}`,
    );
  }
  return parsed;
}
