/**
 * Parity for the managed segment sweep (persistence/journal.ts `sweepSegmentStorage`): the resident owner's garbage
 * collection of segmented page storage on a managed brain, which sweeps only the sources bound to an active worktree
 * this host owns.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    on a managed brain with one source claimed by this host and one claimed by another host, the sweep deletes the
 *    dead staged rows (an aborted staging's manifest rows) of the owned source's segmented page, keeps its live
 *    generation (manifest rows and segment texts), and leaves the other host's source as it was, dead rows included.
 *  - Regression: the sweep deletes data. On a Rust brain its owned-source read ran as raw SQL until
 *    persistenceUpkeepStore served it (managed-parity-rows), so a sweep that read the wrong set would delete another
 *    host's staging or a live generation. This case pins that the owned set is exactly this host's active binding.
 *  - Why existing coverage misses it: segmented-body.test.ts runs sweepSegments directly on an unmanaged brain, and
 *    journal-upkeep-steps.test.ts reads the owned set without sweeping.
 *  - Seam: the other host is a second GBRAIN_HOME (its own host identity) that claims its checkout; everything else
 *    is the real claim, activation and sweep. Ids differ per arm, so the case compares row counts and byte texts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { manifestRow, publishSegmentedPage, segmentText, stagingInput } from '../helpers/page-body-fixtures.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { sweepSegmentStorage } from '../../src/core/persistence/journal.ts';
import { readPersistenceBrain } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

const { parityTest } = parityArms(testBackends());

const LIVE = [segmentText('# Intro\nthe live first segment\n'), segmentText('## End\nthe live second segment\n')];
const DEAD = segmentText('## Dead\na segment only an aborted staging named\n');

/** A one-note Git checkout under `home`, registered as source `id`. */
async function checkout(engine: BrainEngine, backend: ParityBackend, home: string, id: string): Promise<string> {
  const root = join(home, `checkout-${id}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  execFileSync('git', ['-C', root, 'init', '-q']);
  writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
  await createSource(engine, backend, id, {}, root);
  return root;
}

/** A segmented page in `sourceId` with a live generation of LIVE and one aborted staging that staged DEAD. */
async function pageWithDeadStaging(engine: BrainEngine, sourceId: string): Promise<{ pageId: number; stagingId: string }> {
  const slug = `notes/big-${sourceId}`;
  const { pageId } = await publishSegmentedPage(engine, slug, LIVE, { sourceId });
  const staging = stagingInput({ slug, pageId, sourceId, mode: 'replace' });
  const [occurrence] = await engine.allocateBodyOccurrenceIds(1);
  await engine.transaction(async tx => {
    await tx.openBodyStaging(staging);
    await tx.stageSegmentTexts(sourceId, [DEAD], { stagingId: staging.id });
    await tx.stageManifestRows([manifestRow({ pageId, occurrenceId: occurrence!, genFrom: 2, seq: 0, text: DEAD, byteStart: 0, stagingId: staging.id, sourceId })]);
  });
  await engine.setBodyStagingState(staging.id, 'aborted');
  return { pageId, stagingId: staging.id };
}

/** What the sweep may change on one page: its live and staged manifest rows, and whether its live texts still read. */
async function pageState(engine: BrainEngine, page: { pageId: number; stagingId: string }, sourceId: string) {
  const live = (await engine.readManifest(page.pageId)).length;
  const staged = (await engine.readManifest(page.pageId, { stagingId: page.stagingId })).length;
  const texts = await engine.readSegmentTexts(sourceId, LIVE.map(t => t.sha256));
  return { live, staged, liveTexts: texts.size };
}

describe('engine parity: the managed segment sweep', () => {
  parityTest('a managed sweep cleans the owned source, keeps its live generation and skips a source another host owns', {
    methods: ['readWriterAdminState', 'worktreeClaimStore', 'writerReleaseStore', 'createSegmentedPageShell', 'openBodyStaging',
      'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration', 'setBodyStagingState', 'readManifest', 'readSegmentTexts',
      'persistenceUpkeepStore', 'sweepSegments'],
    timeout: 180_000,
  }, async (engine, backend) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-sweep-parity-')));
    const otherHome = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-sweep-parity-other-')));
    try {
      const env = (h: string) => ({ GBRAIN_HOME: h, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined });
      const work = await withEnv(env(home), () => checkout(engine, backend, home, 'work'));
      const other = await withEnv(env(home), () => checkout(engine, backend, home, 'other'));
      const workPage = await pageWithDeadStaging(engine, 'work');
      const otherPage = await pageWithDeadStaging(engine, 'other');
      const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
      // The other host claims its checkout from its own home (its own host identity).
      await withEnv(env(otherHome), async () => {
        await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'other', path: other, ...await reviewed('writer_claim') });
        await disposePersistenceConsumer(engine);
      });
      return await withEnv(env(home), async () => {
        try {
          await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: work, ...await reviewed('writer_claim') });
          const activated = await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') })
            .then(r => (r as { activated?: boolean }).activated ?? null, (e: { code?: string }) => `refused: ${e.code ?? String(e)}`);
          const managed = (await readPersistenceBrain(engine)).enabled;
          const before = { work: await pageState(engine, workPage, 'work'), other: await pageState(engine, otherPage, 'other') };
          const swept = await sweepSegmentStorage(engine).then(() => 'ok', (e: { code?: string }) => `refused: ${e.code ?? String(e)}`);
          const after = { work: await pageState(engine, workPage, 'work'), other: await pageState(engine, otherPage, 'other') };
          const out = { activated, managed, before, swept, after };
          expect(out).toEqual({
            activated: true, managed: true,
            before: { work: { live: 2, staged: 1, liveTexts: 2 }, other: { live: 2, staged: 1, liveTexts: 2 } },
            swept: 'ok',
            after: { work: { live: 2, staged: 0, liveTexts: 2 }, other: { live: 2, staged: 1, liveTexts: 2 } },
          });
          return out;
        } finally { await disposePersistenceConsumer(engine); }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(otherHome, { recursive: true, force: true });
    }
  });
});
