/**
 * BrainEngine parity: the lane 14 swap blockers of the refusal-swallow triage (docs/research/rust-refusal-swallow-triage.tsv
 * on rust-engine/refusal-swallow-triage). Each site ran a raw statement inside a catch that turned the Rust engine's
 * capability refusal into a quiet default (0, an empty list, an omitted field) on a path a non-managed Rust brain reaches.
 * The site now reads a typed member (engine-sql/doctor-tallies.ts, embed-stale-work.ts sumEmbedBackfillChars, the
 * scraper scan's `segmented` flag) or, for `gbrain migrate embeddings`, refuses before it reads anything. Each case is
 * named for its site.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on the same pages, facts, chunks and projections, each check reports the same count on PGLite, Postgres
 *    (with DATABASE_URL) and Rust (GBRAIN_TEST_RUST_ARM=1); `migrate embeddings --status` answers on PGLite and Postgres
 *    and refuses `engine_capability_missing` on Rust.
 *  - Regression: on the parent head the Rust arm reported 0 segmented pages, no lapsed-fact count, "ok: no event
 *    projections yet", an unknown backfill estimate, and a `--status` census with fields quietly missing (exit 0).
 *  - Why existing coverage misses it: the checks ran on PGLite only, where the raw statements succeed.
 *  - Seam: the gateway's test configuration (a priced model, keyless); typed writes seed every arm.
 */
import { afterAll, describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';
import { contentSanityEntry } from '../../src/commands/doctor/checks/content-quality.ts';
import { validityLapsedFactsDetail } from '../../src/commands/doctor/checks/memory-writeback.ts';
import { chronicleProjectionHealthCheck } from '../../src/commands/doctor/report-remote.ts';
import { estimateEmbedBackfillUsd } from '../../src/core/embed-consent.ts';
import { runMigrateEmbeddings } from '../../src/commands/migrate-embeddings.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { bodyColumns, flipInput, segmentText, stageGeneration } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());

configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
afterAll(() => { resetGateway(); });

const page = (title: string, extra: Partial<PageInput> = {}): PageInput => ({ type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra });
const ctx = (engine: BrainEngine) => ({ engine, args: [], progress: { heartbeat() {} } }) as unknown as DoctorContext;
const named = (checks: Check[], name: string): Check & { skipped_segmented?: number } => {
  const check = checks.find(c => c.name === name);
  if (!check) throw new Error(`no ${name} check among ${checks.map(c => c.name).join(', ')}`);
  return check;
};

/** A page stored in segments (its body columns are NULL), published at generation 1. */
async function segmentedPage(engine: BrainEngine, slug: string, text: string): Promise<number> {
  const meta = { type: 'note', title: slug };
  const texts = [segmentText(text)];
  const { id: pageId } = await engine.createSegmentedPageShell(slug, meta as never, { sourceId: 'default' });
  const staged = await stageGeneration(engine, { pageId, slug, genFrom: 1, texts });
  await engine.transaction(async (tx) => {
    await tx.flipBodyGeneration(flipInput(pageId, 0, staged.stagingId, texts, { meta: meta as never, body: bodyColumns(texts) }));
    await tx.setBodyStagingState(staged.stagingId, 'committed');
  });
  return pageId;
}

describe('refusal-swallow swap blockers (lane 14)', () => {
  parityTest(
    'content-quality.ts:70 and :119: content_sanity names the segmented page oversized_pages and scraper_junk_pages skipped',
    { methods: ['countLiveSegmentedPages', 'listScraperJunkCandidates'] },
    async (engine) => {
      await engine.putPage('notes/plain', page('Plain'));
      await segmentedPage(engine, 'notes/segmented', 'segment text');
      await segmentedPage(engine, 'notes/segmented-gone', 'segment text');
      await engine.softDeletePage('notes/segmented-gone');
      const checks = await contentSanityEntry.run(ctx(engine)) as Check[];
      const oversized = named(checks, 'oversized_pages');
      const junk = named(checks, 'scraper_junk_pages');
      const scan = await engine.listScraperJunkCandidates(null);
      const out = {
        oversized: [oversized.status, oversized.skipped_segmented ?? 0],
        junk: [junk.status, junk.skipped_segmented ?? 0],
        segmented: scan.map(r => `${r.slug}:${r.segmented}`).sort(),
        live: await engine.countLiveSegmentedPages(),
      };
      expect(out).toEqual({ oversized: ['ok', 1], junk: ['ok', 1], segmented: ['notes/plain:false', 'notes/segmented:true'], live: 1 });
      return out;
    },
  );

  parityTest(
    'projection-readiness.ts:85: the segmented count with projectionPending counts only pages whose projection is behind',
    { methods: ['countLiveSegmentedPages'] },
    async (engine) => {
      await engine.putPage('notes/plain', page('Plain'));
      await segmentedPage(engine, 'notes/segmented', 'segment text');
      const out = { all: await engine.countLiveSegmentedPages(), pending: await engine.countLiveSegmentedPages({ projectionPending: true }) };
      expect(out.all).toBe(1);
      expect(out.pending).toBeLessThanOrEqual(1);
      return out;
    },
  );

  parityTest(
    'memory-writeback.ts:415: memory_writeback counts a fact past its valid_until, not an expired or open one',
    { methods: ['insertFact', 'expireFact', 'countValidityLapsedFacts'] },
    async (engine) => {
      const fact = (text: string, extra: Record<string, unknown> = {}) =>
        engine.insertFact({ fact: text, entity_slug: null, visibility: 'world', source: 'mcp:remember', embedding: null, ...extra } as never, { source_id: 'default' });
      await fact('an open fact');
      await fact('a fact past its valid_until', { valid_until: new Date('2020-01-01T00:00:00Z') });
      await fact('a fact valid until later', { valid_until: new Date('2099-01-01T00:00:00Z') });
      const expired = await fact('a lapsed fact already expired', { valid_until: new Date('2020-01-01T00:00:00Z') });
      expect(await engine.expireFact(expired.id)).toBe(true);
      const out = { lapsed: await validityLapsedFactsDetail(engine), member: await engine.countValidityLapsedFacts() };
      expect(out).toEqual({ lapsed: 1, member: 1 });
      return out;
    },
  );

  parityTest(
    'report-remote.ts:201: chronicle_projection_health warns on a projection whose event page is soft-deleted, within the caller\'s sources',
    { methods: ['upsertEventProjection', 'softDeletePage', 'countOrphanEventProjections'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const depth = 'meetings/2026-01-05-planning';
      await engine.putPage(depth, { type: 'meeting' as never, title: 'Planning', compiled_truth: 'We planned the launch.', timeline: '' });
      for (const slug of ['life/events/kept', 'life/events/gone']) {
        await engine.putPage(slug, { type: 'event' as never, title: slug, compiled_truth: `${slug} happened.`, timeline: '', frontmatter: { type: 'event' } });
        await engine.upsertEventProjection({ depthSlug: depth, eventSlug: slug, date: '2026-01-05', summary: `${slug} summary`, sourceId: 'default' });
      }
      await engine.softDeletePage('life/events/gone', { sourceId: 'default' });
      const before = await engine.countOrphanEventProjections(null);
      const check = await chronicleProjectionHealthCheck(engine);
      const scopedCheck = await chronicleProjectionHealthCheck(engine, ['other']);
      const out = {
        status: check.status,
        message: check.message,
        scopedStatus: scopedCheck.status,
        all: before,
        scoped: await engine.countOrphanEventProjections(['default']),
        other: await engine.countOrphanEventProjections(['other']),
      };
      expect(out).toMatchObject({ status: 'warn', scopedStatus: 'ok', all: 1, scoped: 1, other: 0 });
      return out;
    },
  );

  parityTest(
    'embed-consent.ts:107: the embed backfill estimate sums unembedded chunk characters and chunkless page characters',
    { methods: ['sumEmbedBackfillChars'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await engine.putPage('notes/chunked', page('Chunked', { compiled_truth: 'é'.repeat(10) }));
      await installFixtureChunks(engine, 'notes/chunked', [{ chunk_index: 0, chunk_text: 'é'.repeat(10), chunk_source: 'compiled_truth', token_count: 4 }]);
      await engine.putPage('notes/chunkless', page('Chunkless', { compiled_truth: '😀'.repeat(7), timeline: 'ab' }));
      await engine.putPage('notes/other', page('Other', { compiled_truth: 'x'.repeat(5) }), { sourceId: 'other' });
      await engine.putPage('notes/gone', page('Gone', { compiled_truth: 'y'.repeat(100) }));
      await engine.softDeletePage('notes/gone');
      const out = {
        stale: await engine.sumEmbedBackfillChars(null, false),
        all: await engine.sumEmbedBackfillChars(null, true),
        source: await engine.sumEmbedBackfillChars('other', false),
        usd: await estimateEmbedBackfillUsd(engine, {}),
      };
      expect(out.stale).toEqual({ chunk_chars: 10, chunkless_chars: 9 + 5 });
      expect(out.all).toEqual({ chunk_chars: 10, chunkless_chars: 0 });
      expect(out.source).toEqual({ chunk_chars: 0, chunkless_chars: 5 });
      expect(typeof out.usd).toBe('number');
      return out;
    },
  );

  parityTest(
    'migrate-embeddings.ts (embedding-migration.ts readMigrationStatus): --status answers on SQL engines and refuses on Rust',
    { methods: ['getConfig'], requires: 'raw_sql' },
    async (engine) => {
      // The command's exit ends the run, as process.exit would: the sentinel stops it at the first exit.
      const exited = new Error('exited');
      let code = null as number | null;
      const log = console.log;
      console.log = () => {};
      try {
        await runMigrateEmbeddings(engine, ['--status'], { exit: ((c: number) => { code = c; throw exited; }) as never })
          .catch((e: unknown) => { if (e !== exited) throw e; });
      } finally {
        console.log = log;
      }
      expect(code).toBe(0);
      return { code };
    },
  );
});
