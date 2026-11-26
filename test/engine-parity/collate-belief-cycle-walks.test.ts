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
 *  - Seam: none. Pages are written through the engine (the tie cases write them in one transaction, which stamps one
 *    updated_at, so slug breaks the tie); the baseline walk reads its events back through the ledger's history reader, the
 *    drift case rewrites the titles in one transaction, the orphan case hard-deletes the pages with `deletePage` (which
 *    tells the ledger nothing), the failed proposals are recorded with `insertTakeProposal` and the window cursor is
 *    stamped with `updateSourceConfig`, all typed members the Rust store serves.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { enableBeliefLedger } from '../../src/core/belief/coverage.ts';
import { orphanLifetimes, scanBeliefDrift } from '../../src/core/belief/coverage-report.ts';
import { readBeliefHistory } from '../../src/core/belief/history.ts';
import { failureTombstoneText, listFailedProposals } from '../../src/core/cycle/propose-takes-failures.ts';
import { listSourceChangedPages, sourceWindow } from '../../src/core/cycle/source-window.ts';
import { PHANTOM_REDIRECT_CURSOR_OP, runPhantomRedirectPass } from '../../src/core/cycle/phantom-redirect.ts';
import { rotationAfter } from '../../src/core/repair/rotation.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { BYTE_SLUGS, byteOrder, MIXED_SLUGS } from '../helpers/byte-order.ts';

const { parityTest } = parityArms(testBackends());

/** Root slugs (no `/`): en_US sorts them `a0, ab, a-z`; bytes put `a-z` first. */
const ROOT_SLUGS = ['ab', 'a0', 'a-z'];

async function put(engine: BrainEngine, slugs: readonly string[]): Promise<void> {
  for (const slug of slugs) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '' });
}

/** Writes the pages in one transaction: they share its updated_at, so only the slug breaks the tie. */
async function putTied(engine: BrainEngine, slugs: readonly string[]): Promise<void> {
  await engine.transaction(tx => put(tx, slugs));
}

describe('belief walks and cycle listings take pages by byte', () => {
  parityTest('enableBeliefLedger baselines pages by byte', { methods: ['putPage', 'transaction', 'readBeliefHistoryRows'] }, async (engine) => {
    await put(engine, MIXED_SLUGS);
    await enableBeliefLedger(engine, 'default');
    // The source's events in id order, through the ledger's one history reader (an owner read, so nothing is filtered).
    const rows = (await readBeliefHistory(engine, { sourceId: 'default', remote: false, limit: 10_000 })).filter(e => e.event_type === 'baseline' && e.subject_kind === 'page');
    expect(rows.map(r => r.slug)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('scanBeliefDrift samples a timestamp tie by byte', { methods: ['putPage', 'transaction', 'listBeliefDriftCandidates', 'readNewestBeliefEvent'] }, async (engine) => {
    await put(engine, MIXED_SLUGS);
    await enableBeliefLedger(engine, 'default');
    // Rewrites every page's title in one transaction, behind the ledger: the pages share the transaction's updated_at, so
    // only the slug orders the sample, and each page's state no longer hashes to its baseline.
    await engine.transaction(async tx => {
      for (const slug of MIXED_SLUGS) await tx.putPage(slug, { type: 'note', title: `${slug} changed`, compiled_truth: `${slug} body`, timeline: '' });
    });
    const scan = await scanBeliefDrift(engine, 'default', { limit: 2 });
    expect(scan.drifted.map(d => d.slug)).toEqual(BYTE_SLUGS.slice(0, 2));
  });

  parityTest('orphanLifetimes samples by byte', { methods: ['putPage', 'transaction', 'deletePage', 'listOrphanLifetimes'] }, async (engine) => {
    await put(engine, MIXED_SLUGS);
    await enableBeliefLedger(engine, 'default');
    // A hard delete the ledger is not told about: each page row goes and its lifetime stays open.
    for (const slug of MIXED_SLUGS) await engine.deletePage(slug, { sourceId: 'default' });
    const orphans = await orphanLifetimes(engine, 'default', 2);
    expect(orphans.count).toBe(3);
    expect(orphans.samples.map(s => s.slug)).toEqual(BYTE_SLUGS.slice(0, 2));
  });

  parityTest('listFailedProposals lists pages by byte', { methods: ['insertTakeProposal', 'listTakeProposalTombstones'] }, async (engine) => {
    for (const slug of MIXED_SLUGS) {
      await engine.insertTakeProposal({ sourceId: 'default', pageSlug: slug, contentHash: 'h', promptVersion: 'v1', proposalRunId: 'run', claimText: failureTombstoneText('llm_error'), kind: 'fact',
        holder: 'brain', weight: 0, domain: null, dedupAgainst: [], modelId: 'm', status: 'rejected' });
    }
    expect((await listFailedProposals(engine, 'default')).map(r => r.slug)).toEqual([...BYTE_SLUGS]);
  });

  parityTest('listSourceChangedPages pages a timestamp tie by byte without a skip', {
    methods: ['putPage', 'transaction', 'readCycleListingInstant', 'readSourceState', 'listSourceChangedPagesAfter', 'updateSourceConfig'],
  }, async (engine) => {
    await putTied(engine, MIXED_SLUGS);
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

  parityTest('runPhantomRedirectPass walks root pages by byte and rotates its cursor through them', { methods: ['putPage', 'getPage', 'listRootPageSlugsAfter', 'readOpCheckpointRecord', 'writeOpCheckpointRecord'] }, async (engine) => {
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
