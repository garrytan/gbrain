/**
 * #9653: every reader of retained page versions is listed here. A reader that returns a version, or copies one back into
 * a live row, applies versionReadableSql (search/private-visibility.ts), so a version a purge hid, or one an owner-only
 * input closes, never comes back. Every other read is listed with why it needs no filter. A new read of page_versions
 * fails this test until it is listed.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Readers that return a version's content or restore it into a live row: each applies versionReadableSql. */
const FILTERED: Record<string, { reads: number; what: string }> = {
  'src/core/engine-sql/pages.ts': { reads: 5, what: 'get_versions list and the engine revert' },
  'src/core/ops/valid-time-read.ts': { reads: 3, what: 'get_page as_of: a purge-marked edition reads as missing' },
  'src/core/belief/page-at-time.ts': { reads: 2, what: 'get_page / get_versions known_as_of bodies, and the remote read check' },
  'src/core/persistence/page-prepare.ts': { reads: 1, what: 'revert_version' },
  'src/core/trust/page-handlers.ts': { reads: 2, what: 'owner revert and restore actions' },
  'src/core/context/proactive-brief.ts': { reads: 1, what: 'the brief\'s recent-edit lines' },
  'src/core/persistence/overwritten-edits.ts': { reads: 2, what: 'overwritten-edit candidates the repair restores' },
  'src/core/repair/overwritten-edits.ts': { reads: 1, what: 'the overwritten-edit restore' },
  'src/core/repair/atoms-restore.ts': { reads: 1, what: 'atom restore from a version' },
  'src/core/repair/lost-fence-rows.ts': { reads: 1, what: 'fence rows restored from history' },
  'src/core/repair/accepted-takes.ts': { reads: 1, what: 'accepted takes restored from a version' },
};

/** Reads that return no version text to a caller and restore none into a live row. */
const INTERNAL: Record<string, { reads: number; why: string }> = {
  'src/commands/doctor/checks/atom-body-recheck.ts': { reads: 1, why: 'doctor compares atom bodies; reports counts' },
  'src/commands/doctor/checks/member-access.ts': { reads: 1, why: 'previous frontmatter for a doctor count' },
  'src/commands/extract-timeline-db.ts': { reads: 1, why: 'existence probe' },
  'src/core/access/federation-exposure.ts': { reads: 1, why: 'writer principals, no body' },
  'src/core/belief/backfill.ts': { reads: 1, why: 'ledger events; bodies are read back through page-at-time' },
  'src/core/belief/preimages.ts': { reads: 3, why: 'existence probes' },
  'src/core/belief/purge.ts': { reads: 2, why: 'purge scrubs versions' },
  'src/core/cycle/synthesize-verify-epochs.ts': { reads: 1, why: 'verification epochs, no body returned' },
  'src/core/engine-sql/page-body.ts': { reads: 1, why: 'segment garbage collection' },
  'src/core/facts/derivation-inputs.ts': { reads: 3, why: 'moves dropped inputs onto versions and marks hidden ones' },
  'src/core/facts/fence-fact-append.ts': { reads: 1, why: 'count' },
  'src/core/facts/file-body-guard.ts': { reads: 1, why: 'compares a file with history; returns a verdict' },
  'src/core/facts/purge-reasons.ts': { reads: 1, why: 'purge redacts change reasons' },
  'src/core/facts/purge-verify.ts': { reads: 4, why: 'purge verification scans every version for purged text' },
  'src/core/facts/purge.ts': { reads: 3, why: 'purge scrubs versions' },
  'src/core/generations/adapters/page.ts': { reads: 1, why: 'generation evidence digest' },
  'src/core/generations/fence-evidence.ts': { reads: 2, why: 'fence evidence comparison' },
  'src/core/ops/admin.ts': { reads: 3, why: 'tier and next-writer metadata for versions get_versions already filtered' },
  'src/core/ops/attribution.ts': { reads: 2, why: 'writer metadata' },
  'src/core/page-body/body-tiling.ts': { reads: 1, why: 'size' },
  'src/core/page-state/versions.ts': { reads: 7, why: 'writes and retention of versions' },
  'src/core/persistence/change-reason.ts': { reads: 1, why: 'newest id' },
  'src/core/persistence/file-repair.ts': { reads: 1, why: 'newest id' },
  'src/core/persistence/git-gap.ts': { reads: 3, why: 'digests compared with Git; no body leaves' },
  'src/core/persistence/local-edit-adoption.ts': { reads: 2, why: 'compares a local file with recent history' },
  'src/core/persistence/maintenance.ts': { reads: 1, why: 'count' },
  'src/core/persistence/moved-pages.ts': { reads: 1, why: 'storage probe' },
  'src/core/persistence/page-mutations.ts': { reads: 1, why: 'source path' },
  'src/core/persistence/page-purge.ts': { reads: 3, why: 'page purge deletes or scrubs versions' },
  'src/core/persistence/unimported-file.ts': { reads: 1, why: 'existence probe' },
  'src/core/repair/attribution-backfill.ts': { reads: 2, why: 'writer metadata' },
  'src/core/repair/purged-change-reasons.ts': { reads: 1, why: 'purge redaction repair' },
  'src/core/repair/redacted-facts.ts': { reads: 1, why: 'redaction repair scrubs versions' },
  'src/core/repair/secret-spans.ts': { reads: 2, why: 'secret scrub' },
  'src/core/timeline-extract.ts': { reads: 4, why: 'timeline witnesses; no body returned' },
  'src/core/trust/label-lowerings.ts': { reads: 1, why: 'tier metadata' },
  'src/core/trust/marker-repair.ts': { reads: 2, why: 'marker frontmatter probe' },
  'src/core/trust/page-write.ts': { reads: 1, why: 'version id by tier' },
  'src/core/trust/provenance-drift.ts': { reads: 1, why: 'writer metadata' },
};

const ROOT = join(import.meta.dir, '..');
const SKIP = /\/schema-migrations\/|generated\.ts$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') && !SKIP.test(path) ? [path] : [];
  });
}

test('every read of page_versions is listed, and every listed reader applies versionReadableSql', () => {
  const reads = new Map<string, number>();
  for (const path of sourceFiles(join(ROOT, 'src'))) {
    const n = readFileSync(path, 'utf8').match(/\b(FROM|JOIN) page_versions\b/g)?.length ?? 0;
    if (n) reads.set(relative(ROOT, path), n);
  }
  expect([...reads.keys()].filter(file => !(file in FILTERED) && !(file in INTERNAL))).toEqual([]);
  const listed = { ...FILTERED, ...INTERNAL };
  expect(Object.entries(listed).filter(([file, entry]) => reads.get(file) !== entry.reads).map(([file]) => file)).toEqual([]);
  expect(Object.keys(FILTERED).filter(file => !/\bversionReadableSql\(/.test(readFileSync(join(ROOT, file), 'utf8')))).toEqual([]);
});
