// The only file the one-off importer accepts: what `convert-notes.mjs` writes.
//   {"count": 750, "notes": [{"createdAt": "…", "modifiedAt": "…", "body": "## …"}]}
// Nothing identifies a note but its dates and body: the importer mints a normal id for each one,
// so an imported note is an ordinary note from then on.
import type { ImportedNote } from '../db/types';

/** The repo refuses a payload over this, so a bigger body could never sync. */
const MAX_BODY = 4_500_000;

const isStamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

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
  const parsed: ImportedNote[] = [];

  notes.forEach((raw: unknown, index) => {
    const at = `note ${index + 1}`;
    if (typeof raw !== 'object' || raw === null) return problems.push(`${at}: not an object`);
    const note = raw as Record<string, unknown>;
    if (!isStamp(note.createdAt)) return problems.push(`${at}: createdAt must be an ISO date`);
    if (!isStamp(note.modifiedAt)) return problems.push(`${at}: modifiedAt must be an ISO date`);
    if (typeof note.body !== 'string') return problems.push(`${at}: body must be a string`);
    if (note.body.length > MAX_BODY) {
      return problems.push(`${at}: body is over ${MAX_BODY} characters and could never sync`);
    }
    parsed.push({
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
