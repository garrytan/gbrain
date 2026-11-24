/**
 * BrainEngine parity: the `gbrain embed --stale` path on every engine arm (engine-sql/embed-stale-work.ts,
 * engine-sql/embedding-provenance.ts, and the width-mismatch recipe of embedding-dim-check.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on the same pages, chunks, signatures and sources, each member returns the same answer on PGLite,
 *    Postgres (with DATABASE_URL) and Rust (GBRAIN_TEST_RUST_ARM=1), and `runEmbedCore({ stale: true })` (what the doctor's
 *    embed.stale remediation runs) embeds the same chunks and reports the same failures and failure samples. A width
 *    mismatch refuses with the same error class, kind and header on every engine, each with its own recipe.
 *  - Regression: on a Rust brain `embed --stale` stopped at the archived-work count's raw SQL ("does not support
 *    executeRaw yet") before any work, a width mismatch refused `engine_capability_missing` instead of the recipe, and
 *    gbrain-evals Cat 19 scored 4/5 gates with 30 pages left unembedded.
 *  - Why existing coverage misses it: the embed tests run on PGLite only, and no parity case ran the embed path.
 *  - Seam: the gateway's test embed transport (deterministic vectors, keyless). Typed writes seed every arm; the
 *    harness's source helpers write raw SQL on the SQL arms and the store on Rust. Timestamps and chunk ids are compared
 *    by shape only.
 */
import { afterAll, describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runEmbedCore } from '../../src/commands/embed.ts';
import { embedStalePages } from '../../src/core/embed-stale.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { computeRecommendations } from '../../src/core/brain-score-recommendations.ts';
import { checkEmbeddingWidthConsistency } from '../../src/commands/doctor/checks/graph-embedding.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import type { PendingProjectionScope } from '../../src/core/engine-sql/embed-stale-work.ts';

const { parityTest } = parityArms(testBackends());

const MODEL = 'openai:text-embedding-3-large';
const DIMS = 1536;
const SIGNATURE = `${MODEL}:${DIMS}`;
const gateway = (dims: number) => configureGateway({ embedding_model: MODEL, embedding_dimensions: dims, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
gateway(DIMS);
__setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
  embeddings: values.map((v) => Array.from({ length: DIMS }, (_, i) => ((v.length + i) % 7) / 10 + 0.01)),
  usage: { tokens: values.length * 4 },
} as never));
afterAll(() => { __setEmbedTransportForTests(null); resetGateway(); });

/** A page with one stored chunk and no vector. */
async function stalePage(engine: BrainEngine, slug: string, sourceId = 'default', frontmatter: Record<string, unknown> = {}): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body text`, frontmatter }, { sourceId });
  await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `${slug} body text`, chunk_source: 'compiled_truth', token_count: 4 }], { sourceId });
}

/** An embed result without the fields that carry a clock or a cursor. */
function stable(result: Record<string, unknown>): Record<string, unknown> {
  const { content_drift, takes: _takes, ...rest } = result as { content_drift?: Record<string, unknown>; takes?: unknown };
  const drift = content_drift ? { state: content_drift.state, checked: content_drift.checked, drifted: content_drift.drifted } : null;
  return { ...rest, content_drift: drift };
}

async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try { return await run(); } finally { console.log = log; }
}

describe('embed --stale', () => {
  parityTest(
    'embed --stale embeds the stale pages of active sources and counts the archived source\'s work as blocked',
    { methods: ['countArchivedEmbeddingWork', 'countEmbedPendingProjections', 'hasEmbeddingSignatureDrift', 'readPageProvenanceComplete', 'lockContentDriftState', 'invalidateContentDriftChunks', 'readSourceRow'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'old');
      await stalePage(engine, 'a/one');
      await stalePage(engine, 'a/two');
      await stalePage(engine, 'b/archived', 'old');
      await archiveSource(engine, backend, 'old');
      const first = stable(await quiet(() => runEmbedCore(engine, { stale: true, quiet: true } as never)) as never);
      const again = stable(await quiet(() => runEmbedCore(engine, { stale: true, quiet: true } as never)) as never);
      expect({ first: [first.embedded, first.failures, first.failure_samples], again: [again.embedded, again.failures] }).toEqual({
        first: [2, 1, ['1 archived page(s) have blocked embedding work; active pages can progress, but this run is incomplete. Use gbrain sources restore <id> deliberately before retrying archived work.']],
        again: [0, 1],
      });
      return { first, again };
    },
  );

  parityTest(
    'a width mismatch refuses with the same error class, kind and header, and each engine\'s own recipe',
    { methods: ['readChunkVectorColumn'] },
    async (engine, backend) => {
      await stalePage(engine, 'a/one');
      gateway(768);
      let error: (Error & { kind?: string; recipeMessage?: string }) | null = null;
      try {
        await quiet(() => runEmbedCore(engine, { stale: true, quiet: true } as never));
      } catch (e) {
        error = e as Error & { kind?: string; recipeMessage?: string };
      } finally {
        gateway(DIMS);
      }
      const lines = (error?.recipeMessage ?? error?.message ?? '').split('\n');
      const head = lines.slice(0, 4);
      expect({ name: error?.name, kind: error?.kind, head }).toEqual({
        name: 'EmbeddingDimMismatchError', kind: 'embedding_dim_mismatch',
        head: ['Refusing to silently re-template existing brain.', '', `  Existing column: vector(${DIMS})`, `  Requested:       vector(768)  (${MODEL})`],
      });
      if (backend === 'rust') {
        expect(lines.slice(4)).toEqual([
          '',
          'Nothing was changed. A Rust brain\'s vector width is fixed when the brain is created, and no command changes it yet.',
          `To embed now, set embedding_model and embedding_dimensions in your config back to a model at vector(${DIMS}).`,
        ]);
      } else if (backend === 'pglite') {
        expect(lines).toContain('PGLite cannot ALTER vector column types in place (pgvector ships as WASM).');
      } else {
        expect(lines).toContain('Recipe (run against your Postgres brain):');
      }
      return { name: error?.name, kind: error?.kind, head };
    },
  );

  // Gap (b): doctor embedding_width_consistency refused on Rust (sqlEngineKind) instead of printing the recipe.
  parityTest(
    'doctor embedding_width_consistency warns with each engine\'s recipe on a width mismatch',
    { methods: ['readChunkVectorColumn'] },
    async (engine, backend) => {
      const ok = await checkEmbeddingWidthConsistency(engine);
      gateway(768);
      let check;
      try { check = await checkEmbeddingWidthConsistency(engine); } finally { gateway(DIMS); }
      const lines = check.message.split('\n');
      const head = lines.slice(0, 6);
      expect({ ok: [ok.status, ok.message], status: check.status, head }).toEqual({
        ok: ['ok', `Schema width (${DIMS}d) matches gateway embedding_dimensions`],
        status: 'warn',
        head: [`Schema width mismatch: content_chunks.embedding is vector(${DIMS}) but gateway resolved embedding_dimensions = 768.`, '',
          'Embedding dimension mismatch detected.', '', `  Existing column: vector(${DIMS})`, `  Requested:       vector(768)  (${MODEL})`],
      });
      if (backend === 'rust') {
        expect(lines.slice(6)).toEqual(['',
          'Nothing was changed. A Rust brain\'s vector width is fixed when the brain is created, and no command changes it yet.',
          `To embed now, set embedding_model and embedding_dimensions in your config back to a model at vector(${DIMS}).`]);
      } else {
        expect(lines.slice(6).join('\n')).toContain(backend === 'pglite' ? 'PGLite cannot ALTER vector column types in place' : 'Recipe (run against your Postgres brain):');
      }
      return { ok: [ok.status, ok.message], status: check.status, head };
    },
  );

  parityTest(
    'the doctor plan recommends embed.stale, and the embed.stale remediation leaves no chunk without a vector',
    { methods: ['getHealth', 'countArchivedEmbeddingWork', 'countEmbedPendingProjections'] },
    async (engine) => {
      for (const n of [1, 2, 3]) {
        await importFromContent(engine, `notes/topic-${n}`, `---\ntitle: Topic ${n}\ntype: note\n---\n\nTopic ${n} links to [[notes/topic-${(n % 3) + 1}]] and says something about subject ${n}.\n`, { noEmbed: true } as never);
      }
      const before = await engine.getHealth();
      const plan = computeRecommendations(before, { embeddingModel: MODEL, embeddingDimensions: DIMS, embeddingProviderConfigured: true, hasChatApiKey: false } as never).map((r) => r.id);
      const result = await quiet(() => runEmbedCore(engine, { stale: true, quiet: true } as never));
      const after = await engine.getHealth();
      const out = {
        planRecommendsEmbed: plan.includes('embed.stale'),
        missingBefore: before.missing_embeddings > 0,
        missingAfter: after.missing_embeddings,
        failures: result.failures,
        failureSamples: result.failure_samples,
        embedded: result.embedded,
        coverageClimbed: after.embed_coverage > before.embed_coverage,
      };
      expect(out).toMatchObject({ planRecommendsEmbed: true, missingBefore: true, missingAfter: 0, failures: 0, failureSamples: [], coverageClimbed: true });
      return out;
    },
  );

  // Gap (a): embedStalePages (the repairs' and synthesize's per-page embed) read the page id and the stale chunk indexes
  // through executeRaw, so a Rust brain stopped before embedding.
  parityTest(
    'embedStalePages embeds the named pages\' stale chunks and skips a deleted or unknown page',
    { methods: ['readLivePageIdBySlug', 'listUnembeddedChunkIndexes'] },
    async (engine) => {
      await stalePage(engine, 'a/one');
      await stalePage(engine, 'a/gone');
      await engine.softDeletePage('a/gone');
      const embedFn = async (texts: string[]) => texts.map((t) => Float32Array.from({ length: DIMS }, (_, i) => ((t.length + i) % 7) / 10 + 0.01));
      const listed = await engine.listUnembeddedChunkIndexes('a/one', 'default', 'embedding');
      const first = await embedStalePages(engine, ['a/one', 'a/gone', 'a/none'], 'default', { embedFn });
      const again = await embedStalePages(engine, ['a/one'], 'default', { embedFn });
      const out = { listed, first, again, after: await engine.listUnembeddedChunkIndexes('a/one', 'default', 'embedding'), stale: await engine.countStaleChunks() };
      expect(out).toEqual({ listed: [0], first: { embedded: 1, pagesProcessed: 1, aborted: false }, again: { embedded: 0, pagesProcessed: 0, aborted: false }, after: [], stale: 0 });
      return out;
    },
  );
});

describe('embed --stale members', () => {
  const scope = (over: Partial<PendingProjectionScope> = {}): PendingProjectionScope =>
    ({ sourceId: null, existingChunksOnly: false, activeSourcesOnly: false, stale: null, ...over });

  parityTest(
    'countArchivedEmbeddingWork counts the live, non-embed_skip pages of archived sources with embedding work',
    { methods: ['countArchivedEmbeddingWork'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'old');
      await createSource(engine, backend, 'other');
      await stalePage(engine, 'a/one', 'old');
      await stalePage(engine, 'a/skip', 'old', { embed_skip: { reason: 'test' } });
      await engine.putPage('a/chunkless', { type: 'note', title: 'chunkless', compiled_truth: 'text with no chunk' }, { sourceId: 'old' });
      await engine.putPage('a/quarantined', { type: 'note', title: 'q', compiled_truth: 'text', frontmatter: { quarantine: { reason: 'test' } } }, { sourceId: 'old' });
      await stalePage(engine, 'a/gone', 'old');
      await engine.softDeletePage('a/gone', { sourceId: 'old' });
      await stalePage(engine, 'a/active', 'other');
      await archiveSource(engine, backend, 'old');
      const count = (o: Partial<Parameters<BrainEngine['countArchivedEmbeddingWork']>[0]> = {}) =>
        engine.countArchivedEmbeddingWork({ sourceId: null, signature: null, includeNullSignature: false, includeUnsealed: false, column: 'embedding', ...o });
      const out = {
        all: await count(), scoped: await count({ sourceId: 'old' }), other: await count({ sourceId: 'other' }),
        nullColumn: await count({ column: null }), unsealed: await count({ includeUnsealed: true }),
        signature: await count({ signature: SIGNATURE, includeNullSignature: true }),
      };
      expect(out).toEqual({ all: 2, scoped: 2, other: 0, nullColumn: 2, unsealed: 3, signature: 2 });
      return out;
    },
  );

  parityTest(
    'the pending-projection reads list the unsealed pages of the scope, the repair read only rebuildable ones after a page id',
    { methods: ['countEmbedPendingProjections', 'listEmbedPendingProjections', 'listEmbedProjectionRepairPages', 'readPageIsSegmented'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'old');
      await stalePage(engine, 'a/sealed');
      await engine.putPage('a/unsealed', { type: 'note', title: 'u', compiled_truth: 'unsealed text' });
      await engine.putPage('a/unsealed-skip', { type: 'note', title: 'u', compiled_truth: 'unsealed text', frontmatter: { embed_skip: { reason: 't' } } });
      await engine.putPage('b/archived', { type: 'note', title: 'b', compiled_truth: 'archived text' }, { sourceId: 'old' });
      await archiveSource(engine, backend, 'old');
      const all = scope();
      const listed = await engine.listEmbedPendingProjections(all, 10);
      const repair = await engine.listEmbedProjectionRepairPages(all, 0, 10);
      const firstId = Number(repair[0]?.id ?? 0);
      const out = {
        count: await engine.countEmbedPendingProjections(all),
        active: await engine.countEmbedPendingProjections(scope({ activeSourcesOnly: true })),
        withChunks: await engine.countEmbedPendingProjections(scope({ existingChunksOnly: true })),
        stale: await engine.countEmbedPendingProjections(scope({ stale: { column: 'embedding', signature: null, includeNullSignature: false } })),
        listed: listed.map((r) => `${r.source_id}:${r.slug}:${r.page_kind}`),
        limited: (await engine.listEmbedPendingProjections(all, 0)).length,
        repair: repair.map((r) => `${r.source_id}:${r.slug}`),
        afterFirst: (await engine.listEmbedProjectionRepairPages(all, firstId, 10)).map((r) => r.slug),
        segmented: await engine.readPageIsSegmented(firstId),
        unknownSegmented: await engine.readPageIsSegmented(987654321),
      };
      expect(out).toEqual({
        count: 2, active: 1, withChunks: 0, stale: 0,
        listed: ['default:a/unsealed:markdown'], limited: 0, repair: ['default:a/unsealed'], afterFirst: [],
        segmented: false, unknownSegmented: false,
      });
      return out;
    },
  );

  parityTest(
    'hasEmbeddingSignatureDrift and readPageProvenanceComplete read the embedded pages\' signatures and vectors',
    { methods: ['hasEmbeddingSignatureDrift', 'readPageProvenanceComplete', 'setPageEmbeddingSignature'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await stalePage(engine, 'a/one');
      await stalePage(engine, 'a/two', 'other');
      await quiet(() => runEmbedCore(engine, { stale: true, quiet: true } as never));
      const drift = (o: Partial<Parameters<BrainEngine['hasEmbeddingSignatureDrift']>[0]> = {}) =>
        engine.hasEmbeddingSignatureDrift({ column: 'embedding', signature: SIGNATURE, sourceId: null, includeNullSignature: false, nullSignatureOnly: false, ...o });
      const clean = { drift: await drift(), nullOnly: await drift({ nullSignatureOnly: true }), withNull: await drift({ includeNullSignature: true }) };
      await engine.setPageEmbeddingSignature('a/two', { sourceId: 'other', signature: 'openai:other-model:1536' });
      const drifted = { drift: await drift(), scopedDefault: await drift({ sourceId: 'default' }), scopedOther: await drift({ sourceId: 'other' }) };
      const provenance = {
        complete: await engine.readPageProvenanceComplete('a/one', 'default', MODEL, DIMS, 'embedding'),
        otherModel: await engine.readPageProvenanceComplete('a/one', 'default', 'openai:other-model', DIMS, 'embedding'),
        otherWidth: await engine.readPageProvenanceComplete('a/one', 'default', MODEL, 768, 'embedding'),
        unknown: await engine.readPageProvenanceComplete('a/none', 'default', MODEL, DIMS, 'embedding'),
      };
      const out = { clean, drifted, provenance };
      expect(out).toEqual({
        clean: { drift: false, nullOnly: false, withNull: false },
        drifted: { drift: true, scopedDefault: false, scopedOther: true },
        provenance: { complete: true, otherModel: false, otherWidth: false, unknown: false },
      });
      return out;
    },
  );

  // Row 44b: a held or capped page leaves the embedding queue (`staleChunkWhere`/`listStaleChunks` add NOT budgetLimited).
  // A conversation-archive hold applies at any page size. The Rust store counted and listed held pages' chunks.
  parityTest(
    'the stale-chunk count, char sum and list leave out a page with an applying embedding hold',
    { methods: ['holdPageEmbedding', 'countStaleChunks', 'sumStaleChunkChars', 'listStaleChunks', 'invalidateContentDriftEmbeddings'] },
    async (engine) => {
      await stalePage(engine, 'a/free');
      await stalePage(engine, 'a/held');
      const before = { count: await engine.countStaleChunks(), chars: await engine.sumStaleChunkChars() };
      const held = await engine.getPage('a/held');
      await engine.holdPageEmbedding(Number(held!.id), 'archive_backfill');
      const out = {
        before,
        count: await engine.countStaleChunks(),
        chars: await engine.sumStaleChunkChars(),
        listed: (await engine.listStaleChunks()).map((r) => r.slug),
        drifted: await engine.invalidateContentDriftEmbeddings(),
      };
      expect(out).toEqual({ before: { count: 2, chars: 'a/free body text'.length + 'a/held body text'.length }, count: 1, chars: 'a/free body text'.length, listed: ['a/free'], drifted: 0 });
      return out;
    },
  );

  parityTest(
    'lockContentDriftState creates the cursor row once, and invalidateContentDriftChunks walks the chunk rows in id windows',
    { methods: ['lockContentDriftState', 'invalidateContentDriftChunks', 'transaction'] },
    async (engine) => {
      await stalePage(engine, 'a/one');
      await stalePage(engine, 'a/two');
      await quiet(() => runEmbedCore(engine, { stale: true, quiet: true } as never));
      const key = 'embed.content_drift_sweep.parity-test';
      const created = await engine.transaction((tx) => tx.lockContentDriftState(key, '{"cursor":0}'));
      await engine.setConfig(key, '{"cursor":7}');
      const kept = await engine.transaction((tx) => tx.lockContentDriftState(key, '{"cursor":0}'));
      const first = await engine.transaction((tx) => tx.invalidateContentDriftChunks({ column: 'embedding', afterChunkId: 0, limit: 1 }));
      const rest = await engine.transaction((tx) => tx.invalidateContentDriftChunks({ column: 'embedding', afterChunkId: Number(first.last_id), limit: 10 }));
      const done = await engine.transaction((tx) => tx.invalidateContentDriftChunks({ column: 'embedding', afterChunkId: Number(rest.last_id), limit: 10, sourceId: 'default' }));
      const shape = (r: { last_id: unknown; checked: unknown; drifted: unknown }) => ({ last: r.last_id === null ? null : 'id', checked: Number(r.checked), drifted: Number(r.drifted) });
      const out = { created, kept, first: shape(first), rest: shape(rest), done: shape(done), stale: await engine.countStaleChunks() };
      expect(out).toEqual({
        created: '{"cursor":0}', kept: '{"cursor":7}',
        first: { last: 'id', checked: 1, drifted: 0 }, rest: { last: 'id', checked: 1, drifted: 0 }, done: { last: null, checked: 0, drifted: 0 },
        stale: 0,
      });
      return out;
    },
  );
});
