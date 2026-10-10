/**
 * W9F item 4: `parseTakesFence` returns reservation rows in `reservedRowNums`,
 * never in `takes`, and every re-render goes through `renderTakesFence` with
 * them. This census names every caller and why it is right about
 * reservations; a new caller fails until someone reviews it here.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const REVIEWED: Record<string, string> = {
  'src/core/cycle/concept-publication.ts': 'compares rows of fence blocks it copies verbatim, reservations included',
  'src/core/cycle/extract-takes.ts': 'projects takes only; a reserved number has no take, so rebuild prunes its stale index row',
  'src/core/cycle/grade-takes.ts': 'looks up live fence rows by number; a reserved number is not a gradeable take',
  'src/core/extract-takes-from-pages.ts': 'dedupes held claims against live takes only',
  'src/core/facts/purge-overlay.ts': 're-renders through renderTakesFence with the fence\'s reservations plus the purged rows\' numbers, so a purged number is never reused (like takes remove)',
  'src/core/fence-repair/content.ts': 'reads warnings only (clean or not)',
  'src/core/fence-repair/import-step.ts': 'hidden rows feed allocation, which nextFreeRowNum already bases on every raw fence row',
  'src/core/fence-repair/page-checks.ts': 'a reserved number used twice in one fence is a parser collision warning',
  'src/core/fence-repair/refusal.ts': 'same warning and collision checks as page-checks',
  'src/core/persistence/canonical-projections.ts': 'projects takes only, so a reservation projects no row and its old row is deleted',
  'src/core/persistence/takes-prepare.ts': 'allocates with nextFreeRowNum, re-renders through upsertTakeRow/supersedeRow/replaceFence, and remove adds the reservation',
  'src/core/repair/connector-fences.ts': 'moves fence blocks verbatim, reservations included',
  'src/core/repair/take-supersession.ts': 're-renders through replaceFence, which keeps the reservations of the body it replaces',
  'src/core/shared-skills/migration-projection.ts': 'compares stored takes with fence takes; neither holds a reservation',
  'src/core/takes-write.ts': 'replaceFence, upsertTakeRow and supersedeRow keep reservations; round-trip checks count takes only',
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

test('every parseTakesFence caller is reviewed for reservation rows', () => {
  // test-reads-source-ok[structural]: a census of call sites, like canonical-writer-inventory.
  const callers = sources(join(root, 'src')).map(path => relative(root, path))
    .filter(path => path !== 'src/core/takes-fence.ts' && readFileSync(join(root, path), 'utf8').includes('parseTakesFence('))
    .sort();
  expect(callers).toEqual(Object.keys(REVIEWED).sort());
});
