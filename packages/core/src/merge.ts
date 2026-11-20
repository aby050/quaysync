import { DELETED, type Change, type StoredDoc } from './types.js';

/**
 * Apply one change to a stored document with per-field last-writer-wins.
 * Returns true when the document changed. Pure apart from mutating `doc`.
 */
export function applyChange(doc: StoredDoc, change: Change): boolean {
  const current = doc.stamps[change.field];
  if (current !== undefined && current >= change.hlc) return false;
  doc.stamps[change.field] = change.hlc;
  if (change.value === undefined) delete doc.values[change.field];
  else doc.values[change.field] = change.value;
  return true;
}

export function emptyDoc(): StoredDoc {
  return { values: {}, stamps: {} };
}

/**
 * A doc is deleted when its tombstone is newer than every field write.
 * So an edit made after a delete brings the document back, which is what
 * users expect when two devices disagree.
 */
export function isDeleted(doc: StoredDoc): boolean {
  const tomb = doc.stamps[DELETED];
  if (!tomb || doc.values[DELETED] !== true) return false;
  for (const [field, stamp] of Object.entries(doc.stamps)) {
    if (field !== DELETED && stamp > tomb) return false;
  }
  return true;
}
