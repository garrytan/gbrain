import { opError } from '../ops/contract.ts';

/** A path as a case-insensitive checkout (macOS, Windows) compares it; persistence/bundle-files.ts folds the same way. */
export function foldSkillPath(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/**
 * The pairs of entries one case-insensitive checkout would store as one: two spellings of a file or directory that
 * differ only by letter case, or a file whose folded path is also a directory of another path. Each pair is keyed by
 * its two spellings, so the same collision has the same key in every inventory.
 */
function caseCollisions(paths: Iterable<string>): Map<string, [string, string]> {
  const kinds = new Map<string, Set<'file' | 'dir'>>();
  const mark = (entry: string, kind: 'file' | 'dir') => (kinds.get(entry) ?? kinds.set(entry, new Set()).get(entry)!).add(kind);
  for (const path of new Set(paths)) {
    mark(path, 'file');
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) mark(segments.slice(0, i).join('/'), 'dir');
  }
  const found = new Map<string, [string, string]>();
  const spellings = new Map<string, string[]>();
  for (const [entry, kind] of [...kinds].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (kind.size > 1) found.set(`${entry}\n${entry}`, [entry, entry]);
    const folded = foldSkillPath(entry);
    (spellings.get(folded) ?? spellings.set(folded, []).get(folded)!).push(entry);
  }
  for (const [first, ...others] of spellings.values()) for (const other of others) found.set(`${first}\n${other}`, [first, other]);
  return found;
}

/**
 * The file in `paths` that is `entry` or, with `under`, lies under it, so a refusal names a published file rather than
 * a directory. An entry used as both a file and a directory names the file for one side and the file under it for the other.
 */
function fileAt(entry: string, paths: Set<string>, prefer: Set<string>, under = false): string {
  if (paths.has(entry) && !under) return entry;
  const inside = [...paths].filter(path => path.startsWith(`${entry}/`)).sort();
  return inside.find(path => prefer.has(path)) ?? inside[0] ?? entry;
}

/**
 * Refuses a publication whose next pack inventory holds a case collision the current one did not. Skill names are
 * lowercase, so only shared convention files can collide across skills, but the whole inventory is compared. A pack
 * that already held a collision, published before this check, keeps publishing its other changes. A trusted local
 * caller learns both spellings; a remote caller and a queued request learn only the path the publication adds, since
 * the other spelling can belong to a skill the caller cannot read.
 */
export function refuseNewCaseCollisions(sourceId: string, before: Iterable<string>, after: Iterable<string>, detailed: boolean): void {
  const prior = new Set(before);
  const next = new Set(after);
  const existing = caseCollisions(prior);
  const added = [...caseCollisions(next)].filter(([key]) => !existing.has(key)).map(([, pair]) => pair);
  if (!added.length) return;
  const fresh = new Set([...next].filter(path => !prior.has(path)));
  const reasons = [...new Set(added.map(([left, right]) => {
    const files = [fileAt(left, next, fresh), fileAt(right, next, fresh, left === right)];
    const [proposed, other] = fresh.has(files[1]) && !fresh.has(files[0]) ? [files[1], files[0]] : files;
    return detailed && proposed !== other ? `${proposed} collides with ${other} on a case-insensitive checkout` : `${proposed} collides by letter case with a file another skill publishes`;
  }))];
  const what = reasons.slice(0, 3).join('; ') + (reasons.length > 3 ? `; and ${reasons.length - 3} more` : '');
  throw opError('local_conflict', `The publication was refused: ${what}. Nothing was written.`,
    `Another skill in source ${sourceId} already publishes a path that differs from this one only by letter case, or a file where this publication needs a directory. Case-insensitive checkouts (macOS, Windows) would store both as one file. Use the exact spelling the other skill publishes to share the file, or pick a name that differs by more than letter case, then submit again with a new request_id.`);
}
