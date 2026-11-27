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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from '../helpers/with-env.ts';
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

  // gbrain migrate embeddings --status --json: every read is a typed member, so the answer is byte-equal on the 3 arms.
  const status = async (engine: BrainEngine): Promise<string> => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-migrate-status-'));
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_EMBEDDING_MODEL: undefined,
        GBRAIN_EMBEDDING_DIMENSIONS: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, OPENROUTER_API_KEY: undefined }, async () => {
        const exited = new Error('exited');
        let code = null as number | null;
        const lines: string[] = [];
        const log = console.log;
        console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
        try {
          await runMigrateEmbeddings(engine, ['--status', '--json'], { exit: ((c: number) => { code = c; throw exited; }) as never })
            .catch((e: unknown) => { if (e !== exited) throw e; });
        } finally {
          console.log = log;
        }
        expect(code).toBe(0);
        return lines.join('\n');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  };

  parityTest(
    'migrate-embeddings.ts --status --json with no migration prints the same answer on every arm',
    { methods: ['putPage', 'upsertChunks', 'insertFacts', 'readEmbeddingColumnTypmod', 'readEmbeddingSignatureCensus', 'countUnembeddedLiveFacts',
      'countSynopsisTierPages', 'countEmbedSkipNullChunks', 'readFalseStampedChunkCounts'] },
    async (engine) => {
      await engine.putPage('notes/a', page('A'));
      await engine.putPage('notes/skipped', page('Skipped', { frontmatter: { embed_skip: true } }));
      await engine.upsertChunks('notes/skipped', [{ chunk_index: 0, chunk_text: 'skipped text', chunk_source: 'compiled_truth' }]);
      await engine.insertFacts([{ fact: 'Alice-example likes tea', entity_slug: null, kind: 'fact', visibility: 'world', source: 'test:status', embedding: null } as never], { source_id: 'default' });
      const out = await status(engine);
      const parsed = JSON.parse(out) as Record<string, unknown>;
      expect({ marker: parsed.marker, embed_skip_null_chunks: parsed.embed_skip_null_chunks, synopsis_tier_pages: parsed.synopsis_tier_pages })
        .toEqual({ marker: { kind: 'none' }, embed_skip_null_chunks: 1, synopsis_tier_pages: 0 });
      return out;
    },
  );

  parityTest(
    'migrate-embeddings.ts --status --json counts a page stamped with the target but embedded by another model, the same on every arm',
    { methods: ['putPage', 'setPageEmbeddingSignature', 'readEmbeddingSignatureCensus', 'readFalseStampedChunkCounts'] },
    async (engine) => {
      // #4305: the page's signature says the target model, but its chunk's vector came from another model.
      const vector = new Float32Array(1536).map((_, i) => Math.sin(i) * 0.01 + 0.001);
      await engine.putPage('notes/stamped', page('Stamped'));
      await installFixtureChunks(engine, 'notes/stamped', [{ chunk_index: 0, chunk_text: 'stamped text', chunk_source: 'compiled_truth', embedding: vector, model: 'voyage:voyage-4' }]);
      await engine.putPage('notes/honest', page('Honest'));
      await installFixtureChunks(engine, 'notes/honest', [{ chunk_index: 0, chunk_text: 'honest text', chunk_source: 'compiled_truth', embedding: vector, model: 'openai:text-embedding-3-large' }]);
      for (const slug of ['notes/stamped', 'notes/honest']) await engine.setPageEmbeddingSignature(slug, { signature: 'openai:text-embedding-3-large:1536' });
      const out = await status(engine);
      const parsed = JSON.parse(out) as { stale_vs_target: { false_stamped: number | null }; signature_census: unknown };
      expect(parsed.stale_vs_target.false_stamped).toBe(1);
      expect(parsed.signature_census).toEqual([{ signature: 'openai:text-embedding-3-large:1536', pages: 2 }]);
      return out;
    },
  );

  parityTest(
    'migrate-embeddings.ts --status --json with a live retargeted marker prints the same answer and resume command on every arm',
    { methods: ['putPage', 'setConfig', 'readEmbeddingColumnTypmod', 'readEmbeddingSignatureCensus', 'readFalseStampedChunkCounts'] },
    async (engine) => {
      // A marker only a migration writes; a Rust brain never runs one (the migration refuses there), but the status read
      // answers the same for the same stored config row.
      await engine.putPage('notes/a', page('A'));
      await engine.setConfig('embedding_migration.state', JSON.stringify({ version: 2, to_model: 'openai:text-embedding-3-small', to_dims: 768,
        from_model: 'openai:text-embedding-3-large', from_dims: 1536, started_at: '2026-11-01T00:00:00.000Z', retargeted_at: '2026-11-02T00:00:00.000Z',
        superseded: [{ to_model: 'voyage:voyage-4', to_dims: 1024, started_at: '2026-10-30T00:00:00.000Z' }] }));
      const out = await status(engine);
      const parsed = JSON.parse(out) as { marker: { kind: string }; resume_command: string | null };
      expect(parsed.marker.kind).toBe('live');
      expect(parsed.resume_command).toContain('--to openai:text-embedding-3-small --dim 768');
      return out;
    },
  );

  parityTest(
    'migrate-embeddings.ts --status --json after a completed migration prints the same answer on every arm',
    { methods: ['putPage', 'setConfig', 'readEmbeddingColumnTypmod', 'readEmbeddingSignatureCensus', 'countUnembeddedLiveFacts'] },
    async (engine) => {
      await engine.putPage('notes/a', page('A'));
      await engine.setConfig('embedding_migration.completed', JSON.stringify({ to_model: 'openai:text-embedding-3-large', to_dims: 1536,
        completed_at: '2026-11-01T00:00:00.000Z', verify_search: true }));
      const out = await status(engine);
      expect((JSON.parse(out) as { completed: unknown }).completed).toEqual({ to_model: 'openai:text-embedding-3-large', to_dims: 1536,
        completed_at: '2026-11-01T00:00:00.000Z', verify_search: true });
      return out;
    },
  );
});
