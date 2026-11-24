/**
 * Guard for TYPED_PREPARATION_READS (persistence/bounded-reads.ts): every engine method a preparer calls through its
 * bounded view on Postgres must be a typed preparation read, which ends at the claim's deadline and the clock's abort,
 * or be named below with the reason it may stay unbounded. A new engine read added to a page-write, managed-sync or
 * maintenance preparation that is in neither list fails this file, so it cannot silently outlive the preparation budget.
 *
 * It runs representative Postgres flows with the view's observer seam installed: managed maintenance (the page and
 * maintenance preparers), a managed sync (the engineReads view), the fact-fence backstop (fact adoption) and a
 * segmented-body sync replace (body staging). The amends-link and wanted-links flows join when their code lands.
 * CI runs one process per e2e file (scripts/run-e2e.sh), so every imported flow runs here under the observer.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { observePreparationMembers, TYPED_PREPARATION_READS } from '../../src/core/persistence/bounded-reads.ts';
import { registerPostgresTests } from '../helpers/test-backends.ts';
import { defineSegmentedSyncReplacePostgresArm } from '../helpers/segmented-sync-replace-postgres-arm.ts';

/** Engine methods a bounded view may hand out unwrapped, each with the reason. Keep it short: prefer a typed read. */
const STAGING_WRITE = 'a segmented body staging write the managed sync makes before its claim, not a preparation read';
const UNBOUNDED_ALLOWED: ReadonlyMap<string, string> = new Map<string, string>([
  ['transaction', STAGING_WRITE],
  ['openBodyStaging', STAGING_WRITE],
  ['setBodyStagingState', STAGING_WRITE],
  ['allocateBodyOccurrenceIds', STAGING_WRITE],
  ['stageSegmentChunks', STAGING_WRITE],
]);

const seen = new Map<string, { typed: boolean; views: Set<'engineReads' | 'plain'> }>();
const RUN = !!process.env.DATABASE_URL;

if (RUN) {
  observePreparationMembers((member, typed, engineReads) => {
    const entry = seen.get(member) ?? { typed, views: new Set() };
    entry.views.add(engineReads ? 'engineReads' : 'plain');
    seen.set(member, entry);
  });
  await registerPostgresTests(
    () => import('../managed-maintenance.test.ts'),
    () => import('../pathological/s-managed-sync-job-pull.test.ts'),
    () => import('../managed-facts-backstop.test.ts'),
  );
  // The Postgres-only flows come from their shared helpers: an e2e file may not import another e2e test file.
  defineSegmentedSyncReplacePostgresArm();
}

(RUN ? describe : describe.skip)('typed preparation reads guard (Postgres)', () => {
  afterAll(() => observePreparationMembers(undefined));

  test('the flows reached both bounded views through typed reads', () => {
    const views = new Set([...seen.values()].filter(entry => entry.typed).flatMap(entry => [...entry.views]));
    expect([...views].sort()).toEqual(['engineReads', 'plain']);
  });

  test('every engine method a preparer called through its bounded view is a typed preparation read or allowed', () => {
    const unlisted = [...seen].filter(([member, entry]) => !entry.typed && !UNBOUNDED_ALLOWED.has(member))
      .map(([member, entry]) => `${member} (${[...entry.views].sort().join(', ')} view)`).sort();
    expect(unlisted, `These engine methods ran on a bounded preparer view without the preparation deadline. Make each end at the deadline and add it to TYPED_PREPARATION_READS (src/core/persistence/bounded-reads.ts, with a row in test/typed-preparation-reads-sweep.test.ts), or name it in UNBOUNDED_ALLOWED here with the reason it may stay unbounded`).toEqual([]);
  });

  test('every allowed name is still unbounded', () => {
    expect([...UNBOUNDED_ALLOWED.keys()].filter(member => TYPED_PREPARATION_READS.has(member))).toEqual([]);
  });
});
