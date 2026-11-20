/**
 * Belief-ledger walks and cycle listings take pages by byte order of slug on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    these readers order and page slugs by byte, as PGLite does: the belief baseline walk (enableBeliefLedger), the
 *    drift sample (scanBeliefDrift), the orphan lifetime sample (orphanLifetimes), the failed take proposals
 *    (listFailedProposals), the cycle's changed-page window and its cursor (listSourceChangedPages), and the phantom
 *    redirect pass and its rotation cursor (runPhantomRedirectPass).
 *  - Regression: an en_US Postgres sorted and compared slugs by its locale, which skips `-` and `/` (`ab, a/z, a-z`
 *    instead of `a-z, a/z, ab`), so these walks visited, sampled and listed pages in another order than a PGLite brain,
 *    and a cursor saved from one walk named another page.
 *  - Why existing coverage misses it: the tests of these readers use slugs that sort the same in every locale, and CI's
 *    Postgres runs in C.UTF-8. Every case here uses slugs that differ by byte and by en_US; run it against an en_US
 *    Postgres to see it fail.
 *  - Seam: pages are written through the engine. The shared updated_at that slug breaks (listSourceChangedPages) is set by
 *    the harness: SQL on PGLite and Postgres, the test-only seed seedPageUpdatedAt on the Rust arm (an addon built with
 *    GBRAIN_RUST_TEST_SEEDS=1). The window cursor is stamped through updateSourceConfig. Harness-only SQL changes a title
 *    behind the ledger (drift), deletes a page row (an orphan lifetime) and inserts failure tombstones. The window answers
 *    from typed members, so the Rust arm answers it; the other readers here run raw SQL, so the Rust arm stops on raw_sql.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { enableBeliefLedger } from '../../src/core/belief/coverage.ts';
import { orphanLifetimes, scanBeliefDrift } from '../../src/core/belief/coverage-report.ts';
import { failureTombstoneText, listFailedProposals } from '../../src/core/cycle/propose-takes-failures.ts';
import { listSourceChangedPages, sourceWindow } from '../../src/core/cycle/source-window.ts';
import { PHANTOM_REDIRECT_CURSOR_OP, runPhantomRedirectPass } from '../../src/core/cycle/phantom-redirect.ts';
import { rotationAfter } from '../../src/core/repair/rotation.ts';
import { parityArms, stampUpdatedAtExact } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { BYTE_SLUGS, byteOrder, MIXED_SLUGS } from '../helpers/byte-order.ts';

const { parityTest } = parityArms(testBackends());

/** Root slugs (no `/`): en_US sorts them `a0, ab, a-z`; bytes put `a-z` first. */
const ROOT_SLUGS = ['ab', 'a0', 'a-z'];
const STAMP = '2026-01-01T00:00:00Z';

async function put(engine: BrainEngine, slugs: readonly string[]): Promise<void> {
  for (const slug of slugs) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '' });
}

describe('belief walks and cycle listings take pages by byte', () => {
  parityTest('enableBeliefLedger baselines pages by byte', { methods: ['putPage', 'executeRaw', 'transaction'], requires: 'raw_sql' }, async (engine) => {
    await put(engine, MIXED_SLUGS);
    await enableBeliefLedger(engine, 'default');
    const rows = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM belief_events
      WHERE source_id = 'default' AND event_type = 'baseline' AND subject_kind = 'page' ORDER BY id`);
    expect(rows.map(r => r.slug)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('scanBeliefDrift samples a timestamp tie by byte', { methods: ['putPage', 'executeRaw', 'transaction'], requires: 'raw_sql' }, async (engine) => {
    await put(engine, MIXED_SLUGS);
    await enableBeliefLedger(engine, 'default');
    await engine.executeRaw(`UPDATE pages SET title = title || ' changed', updated_at = $1::timestamptz WHERE source_id = 'default'`, ['2099-01-01T00:00:00Z']);
    const scan = await scanBeliefDrift(engine, 'default', { limit: 2 });
    expect(scan.drifted.map(d => d.slug)).toEqual(BYTE_SLUGS.slice(0, 2));
  });

  parityTest('orphanLifetimes samples by byte', { methods: ['putPage', 'executeRaw', 'transaction'], requires: 'raw_sql' }, async (engine) => {
    await put(engine, MIXED_SLUGS);
    await enableBeliefLedger(engine, 'default');
    await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'default' AND slug = ANY($1::text[])`, [[...MIXED_SLUGS]]);
    const orphans = await orphanLifetimes(engine, 'default', 2);
    expect(orphans.count).toBe(3);
    expect(orphans.samples.map(s => s.slug)).toEqual(BYTE_SLUGS.slice(0, 2));
  });

  parityTest('listFailedProposals lists pages by byte', { methods: ['recordFailureTombstone', 'listFailureTombstones'] }, async (engine) => {
    for (const slug of MIXED_SLUGS) {
      expect(await engine.recordFailureTombstone({ sourceId: 'default', slug, contentHash: 'h', promptVersion: 'v1', proposalRunId: 'run', claimText: failureTombstoneText('llm_error'), modelId: 'm' })).toBe(true);
    }
    expect(await engine.recordFailureTombstone({ sourceId: 'default', slug: MIXED_SLUGS[0], contentHash: 'h', promptVersion: 'v1', proposalRunId: 'run2', claimText: failureTombstoneText('llm_error'), modelId: 'm' })).toBe(false);
    const listed = await listFailedProposals(engine, 'default');
    expect(listed.map(r => r.slug)).toEqual([...BYTE_SLUGS]);
    expect(listed.every(r => r.code === 'llm_error' && r.prompt_version === 'v1')).toBe(true);
  });

  parityTest('listSourceChangedPages pages a timestamp tie by byte without a skip', { methods: ['putPage', 'readSourceState', 'updateSourceConfig', 'readCycleListingInstant', 'listSourceChangedPagesAfter'], testSeeds: true }, async (engine, backend) => {
    await put(engine, MIXED_SLUGS);
    for (const slug of MIXED_SLUGS) await stampUpdatedAtExact(engine, backend, 'default', slug, STAMP);
    const limit = sourceWindow.pageLimit;
    sourceWindow.pageLimit = 1;
    try {
      const seen: string[] = [];
      let since: string | null = null;
      for (let i = 0; i <= MIXED_SLUGS.length; i++) {
        const window = await listSourceChangedPages(engine, 'default', since);
        seen.push(...window.slugs);
        if (!window.next?.slug) break;
        await engine.updateSourceConfig('default', { last_source_cycle_window_at: window.next.at, last_source_cycle_window_slug: window.next.slug });
        since = window.next.at;
      }
      expect(seen).toEqual([...BYTE_SLUGS]);
    } finally {
      sourceWindow.pageLimit = limit;
    }
  });

  parityTest('runPhantomRedirectPass walks root pages by byte and rotates its cursor through them', { methods: ['putPage', 'getPage', 'executeRaw'], requires: 'raw_sql' }, async (engine) => {
    await put(engine, ROOT_SLUGS);
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-collate-phantom-'));
    try {
      await withEnv({ GBRAIN_PHANTOM_REDIRECT_LIMIT: '1', GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        const cursors: Array<string | null> = [];
        for (let i = 0; i < ROOT_SLUGS.length; i++) {
          await runPhantomRedirectPass(engine, dir, 'default', false);
          cursors.push(await rotationAfter(engine, PHANTOM_REDIRECT_CURSOR_OP, 'default'));
        }
        expect(cursors).toEqual(byteOrder(ROOT_SLUGS).slice(0, 2).concat(['']));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
