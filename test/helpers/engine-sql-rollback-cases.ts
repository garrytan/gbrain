/**
 * Per-domain write-then-throw rollback cases for the engine-sql executor
 * (refactor wave 1, EO1 / T-G1). Each W1-core domain commit adds its case.
 *
 * A case seeds state outside the transaction THROUGH THE SAME DOMAIN on the
 * root engine (so a long-lived engine's executor has been used before the
 * transaction starts), performs one migrated domain write through the
 * TRANSACTION CLONE (so the write resolves the clone's
 * `engineSql`), and reads the observed value back. The runner asserts:
 *   - inside the transaction the write is visible to the clone,
 *   - on Postgres a concurrent pool read during the transaction does not see it,
 *   - after the body throws, the value equals the seeded value.
 * A regression that caches the executor on the engine (bound to the pool at
 * connect time) makes the write commit outside the transaction and fails.
 */
import { expect, test } from 'bun:test';
import { ROW_BATCH_MAX_ROWS } from '../../src/core/batch-rows.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { invalidateStaleSignatureEmbeddingsGuarded } from '../../src/core/embedding-invalidation.ts';
import { reconcileContextualEmbeddingInputs } from '../../src/core/page-state/contextual-proof.ts';
import { installPageProjection, readProjectionSnapshot } from '../../src/core/page-state/projections.ts';
import { installFixtureChunks } from './page-projection.ts';
import { chunk, flipInput, hexOf, manifestRow, pageMeta, publishSegmentedPage, segmentText, stageGeneration, stagingInput } from './page-body-fixtures.ts';

export interface RollbackCase {
  domain: string;
  seed(engine: BrainEngine): Promise<void>;
  write(tx: BrainEngine): Promise<void>;
  observe(engine: BrainEngine): Promise<unknown>;
}

const SLUG = 'notes/engine-sql-rollback-alice-example';
const LINK_TARGET = 'notes/engine-sql-rollback-target-alice-example';

async function seedPage(engine: BrainEngine): Promise<void> {
  await engine.putPage(SLUG, { type: 'note', title: 'Rollback probe', compiled_truth: 'body' });
}

export const ROLLBACK_CASES: RollbackCase[] = [
  {
    domain: 'salience',
    async seed(engine) {
      await seedPage(engine);
      await engine.setEmotionalWeightBatch([{ slug: SLUG, source_id: 'default', weight: 0.25 }]);
    },
    async write(tx) {
      const changed = await tx.setEmotionalWeightBatch([{ slug: SLUG, source_id: 'default', weight: 0.75 }]);
      expect(changed).toBe(1);
    },
    async observe(engine) {
      const rows = await engine.executeRaw<{ w: number }>(
        `SELECT emotional_weight::float8 AS w FROM pages WHERE slug = $1 AND source_id = 'default'`, [SLUG]);
      return Number(rows[0]?.w ?? 0);
    },
  },
  {
    domain: 'facts',
    async seed(engine) {
      await engine.insertFact(
        { fact: 'seeded rollback fact', source: 'test:rollback', entity_slug: 'people/alice-example' },
        { source_id: 'default' },
      );
    },
    async write(tx) {
      const res = await tx.insertFact(
        { fact: 'rolled-back fact', source: 'test:rollback', entity_slug: 'people/alice-example' },
        { source_id: 'default' },
      );
      expect(res.status).toBe('inserted');
    },
    async observe(engine) {
      const rows = await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM facts WHERE source_id = 'default' AND fact = 'rolled-back fact'`);
      return Number(rows[0]?.n ?? 0);
    },
  },
  {
    domain: 'takes',
    async seed(engine) {
      await seedPage(engine);
      await engine.addTakesBatch([{ page_id: await pageId(engine), row_num: 1, claim: 'rollback claim', kind: 'take', holder: 'alice-example', weight: 0.25 }]);
    },
    async write(tx) {
      const n = await tx.addTakesBatch([{ page_id: await pageId(tx), row_num: 1, claim: 'rollback claim', kind: 'take', holder: 'alice-example', weight: 0.75 }]);
      expect(n).toBe(1);
    },
    async observe(engine) {
      const rows = await engine.executeRaw<{ w: number }>(
        `SELECT t.weight::float8 AS w FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1 AND t.row_num = 1`, [SLUG]);
      return Number(rows[0]?.w ?? 0);
    },
  },
  {
    domain: 'code-edges',
    async seed(engine) {
      await seedPage(engine);
      await engine.addCodeEdges([{ from_chunk_id: await rollbackChunk(engine), to_chunk_id: null, from_symbol_qualified: 'run', to_symbol_qualified: 'seeded-target', edge_type: 'calls' }]);
    },
    async write(tx) {
      const n = await tx.addCodeEdges([{ from_chunk_id: await rollbackChunk(tx), to_chunk_id: null, from_symbol_qualified: 'run', to_symbol_qualified: 'rolled-back-target', edge_type: 'calls' }]);
      expect(n).toBe(1);
    },
    async observe(engine) {
      const rows = await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM code_edges_symbol WHERE to_symbol_qualified = 'rolled-back-target'`);
      return Number(rows[0]?.n ?? 0);
    },
  },
  {
    domain: 'sources',
    async seed(engine) {
      expect(await engine.updateSourceConfig('default', { engine_sql_rollback_probe: 'seeded' })).toBe(true);
    },
    async write(tx) {
      expect(await tx.updateSourceConfig('default', { engine_sql_rollback_probe: 'rolled-back' })).toBe(true);
    },
    async observe(engine) {
      const rows = await engine.executeRaw<{ v: string | null }>(
        `SELECT config->>'engine_sql_rollback_probe' AS v FROM sources WHERE id = 'default'`);
      return rows[0]?.v ?? null;
    },
  },
  {
    domain: 'files',
    async seed(engine) {
      await engine.upsertFile({ filename: 'rollback.png', storage_path: 'attachments/engine-sql-rollback.png', content_hash: 'seeded' });
    },
    async write(tx) {
      const res = await tx.upsertFile({ filename: 'rollback.png', storage_path: 'attachments/engine-sql-rollback.png', content_hash: 'rolled-back' });
      expect(res.created).toBe(false);
    },
    async observe(engine) {
      const rows = await engine.executeRaw<{ h: string }>(
        `SELECT content_hash AS h FROM files WHERE storage_path = 'attachments/engine-sql-rollback.png'`);
      return rows[0]?.h ?? null;
    },
  },
  {
    domain: 'chunks (upsertChunks)',
    async seed(engine) {
      await seedPage(engine);
      await engine.upsertChunks(SLUG, [{ chunk_index: 0, chunk_text: 'seeded chunk', chunk_source: 'compiled_truth' }]);
    },
    async write(tx) {
      await tx.upsertChunks(SLUG, [{ chunk_index: 0, chunk_text: 'rolled-back chunk', chunk_source: 'compiled_truth' }]);
    },
    observe: chunkTexts,
  },
  {
    // A3: a replacement larger than one row batch commits as several INSERTs
    // after one prune; all of them leave with the transaction.
    domain: 'chunks (upsertChunks, several row batches)',
    async seed(engine) {
      await seedPage(engine);
      await engine.upsertChunks(SLUG, [{ chunk_index: 0, chunk_text: 'seeded chunk', chunk_source: 'compiled_truth' }]);
    },
    async write(tx) {
      await tx.upsertChunks(SLUG, Array.from({ length: ROW_BATCH_MAX_ROWS * 2 + 1 }, (_, i) => ({
        chunk_index: i, chunk_text: `rolled-back chunk ${i}`, chunk_source: 'compiled_truth' as const })));
    },
    observe: chunkTexts,
  },
  {
    domain: 'chunks (deleteChunks)',
    async seed(engine) {
      await seedPage(engine);
      await engine.upsertChunks(SLUG, [{ chunk_index: 0, chunk_text: 'seeded chunk', chunk_source: 'compiled_truth' }]);
    },
    async write(tx) {
      await tx.deleteChunks(SLUG);
    },
    observe: chunkTexts,
  },
  {
    domain: 'chunks (setPageEmbeddingSignature)',
    async seed(engine) {
      await seedPage(engine);
      await engine.setPageEmbeddingSignature(SLUG, { signature: 'seeded:3' });
    },
    async write(tx) {
      await tx.setPageEmbeddingSignature(SLUG, { signature: 'rolled-back:3' });
    },
    async observe(engine) {
      const rows = await engine.executeRaw<{ s: string | null }>(
        `SELECT embedding_signature AS s FROM pages WHERE slug = $1 AND source_id = 'default'`, [SLUG]);
      return rows[0]?.s ?? null;
    },
  },
  // Every site that leaves a chunk without its vector stamps
  // embedding_pending_since (doctor ages the embedding backlog from it).
  // Seeded embedded, so the stamp is NULL before the write.
  {
    domain: 'chunks (upsertChunks insert without a vector stamps embedding_pending_since)',
    async seed(engine) {
      await seedPage(engine);
      await engine.deleteChunks(SLUG);
    },
    async write(tx) {
      await tx.upsertChunks(SLUG, [{ chunk_index: 0, chunk_text: 'pending chunk', chunk_source: 'compiled_truth' }]);
      expect(await vectorState(tx)).toEqual({ missing: true, pending: true });
    },
    observe: pendingStamp,
  },
  {
    domain: 'chunks (upsertChunks text change NULLs the vector and stamps embedding_pending_since)',
    seed: (engine) => seedEmbeddedChunk(engine),
    async write(tx) {
      await tx.upsertChunks(SLUG, [{ chunk_index: 0, chunk_text: 'edited chunk', chunk_source: 'compiled_truth' }]);
      expect(await vectorState(tx)).toEqual({ missing: true, pending: true });
    },
    observe: pendingStamp,
  },
  {
    domain: 'chunks (invalidateStaleSignatureEmbeddings stamps embedding_pending_since)',
    seed: (engine) => seedEmbeddedChunk(engine),
    async write(tx) {
      expect(await tx.invalidateStaleSignatureEmbeddings({ signature: await swapSignature(tx), includeNullSignature: true })).toBe(1);
      expect(await vectorState(tx)).toEqual({ missing: true, pending: true });
    },
    observe: pendingStamp,
  },
  {
    domain: 'chunks (invalidateContentDriftEmbeddings stamps embedding_pending_since)',
    async seed(engine) {
      await seedEmbeddedChunk(engine);
      await engine.executeRaw(`UPDATE content_chunks SET chunk_text = 'drifted chunk'
        WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default')`, [SLUG]);
    },
    async write(tx) {
      expect(await tx.invalidateContentDriftEmbeddings()).toBe(1);
      expect(await vectorState(tx)).toEqual({ missing: true, pending: true });
    },
    observe: pendingStamp,
  },
  {
    domain: 'embedding-invalidation (guarded model-swap invalidation stamps embedding_pending_since)',
    seed: (engine) => seedEmbeddedChunk(engine),
    async write(tx) {
      expect(await invalidateStaleSignatureEmbeddingsGuarded(tx, { signature: await swapSignature(tx), includeNullSignature: true })).toBe(1);
      expect(await vectorState(tx)).toEqual({ missing: true, pending: true });
    },
    observe: pendingStamp,
  },
  {
    domain: 'pages (contextual mode back to none stamps embedding_pending_since)',
    async seed(engine) {
      await seedEmbeddedChunk(engine);
      await engine.executeRaw(`UPDATE pages SET contextual_retrieval_mode = 'title' WHERE slug = $1 AND source_id = 'default'`, [SLUG]);
    },
    async write(tx) {
      await tx.updatePageContextualRetrievalState(SLUG, 'default', 'none', null);
      expect(await vectorState(tx)).toEqual({ missing: true, pending: true });
    },
    observe: pendingStamp,
  },
  {
    domain: 'contextual proof (a vector from a retired model input stamps embedding_pending_since)',
    seed: (engine) => seedEmbeddedChunk(engine, RETIRED_MODEL),
    async write(tx) {
      const snapshot = await tx.readPageSnapshot(SLUG, { sourceId: 'default' });
      expect(await reconcileContextualEmbeddingInputs(tx, snapshot!, 'none', null)).toBe(1);
      expect(await vectorState(tx)).toEqual({ missing: true, pending: true });
    },
    observe: pendingStamp,
  },
  {
    domain: 'projections (a re-seal that drops a retired vector stamps embedding_pending_since)',
    seed: (engine) => seedEmbeddedChunk(engine, RETIRED_MODEL),
    async write(tx) {
      const snapshot = await readProjectionSnapshot(tx, SLUG, 'default', { allowUnsealed: true });
      await installPageProjection(tx, snapshot!, [{ chunk_index: 0, chunk_text: EMBEDDED_TEXT, chunk_source: 'compiled_truth' }],
        { seal: true, preserveEmbeddings: true });
      expect(await vectorState(tx)).toEqual({ missing: true, pending: true });
    },
    observe: pendingStamp,
  },
  {
    domain: 'pages',
    async seed(engine) {
      await seedPage(engine);
    },
    async write(tx) {
      const page = await tx.putPage(SLUG, { type: 'note', title: 'Rollback probe', compiled_truth: 'rolled-back body' });
      expect(page.compiled_truth).toBe('rolled-back body');
      expect(await tx.softDeletePage(SLUG, { sourceId: 'default' })).toEqual({ slug: SLUG });
    },
    async observe(engine) {
      const rows = await engine.executeRaw<{ body: string; deleted: boolean }>(
        `SELECT compiled_truth AS body, deleted_at IS NOT NULL AS deleted FROM pages WHERE slug = $1 AND source_id = 'default'`, [SLUG]);
      return rows[0] ? { body: rows[0].body, deleted: rows[0].deleted } : null;
    },
  },
  {
    domain: 'pages (stale reserved frontmatter keys, #6454)',
    async seed(engine) {
      await seedPage(engine);
      await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"type":"legacy","title":"Stored Title"}'::jsonb WHERE slug = $1 AND source_id = 'default'`, [SLUG]);
    },
    async write(tx) {
      const [row] = await tx.listStaleFrontmatterKeyPages({ sourceId: 'default', afterId: 0, limit: 10 });
      expect(row).toMatchObject({ slug: SLUG, keys: ['title', 'type'] });
      expect(await tx.countStaleFrontmatterKeyPages({ sourceIds: ['default'] })).toEqual([{ source_id: 'default', n: 1 }]);
      expect(await tx.stripStaleFrontmatterKeys({ sourceId: 'default', ids: [row.id] })).toBe(1);
      expect(await tx.countStaleFrontmatterKeyPages({ sourceIds: ['default'] })).toEqual([]);
    },
    async observe(engine) {
      const rows = await engine.executeRaw<{ stale: boolean }>(
        `SELECT frontmatter ?| ARRAY['type','title','tags','slug'] AS stale FROM pages WHERE slug = $1 AND source_id = 'default'`, [SLUG]);
      return rows[0]?.stale ?? null;
    },
  },
  {
    domain: 'pages (attendance marker)',
    async seed(engine) {
      await seedPage(engine);
    },
    async write(tx) {
      const snapshot = await tx.readPageSnapshot(SLUG, { sourceId: 'default' });
      expect(await tx.markPagesAttendanceBlocked([{ slug: SLUG, source_id: 'default', revision: snapshot!.revision }])).toBe(1);
    },
    async observe(engine) {
      const rows = await engine.executeRaw<{ blocked: boolean }>(
        `SELECT links_attendance_blocked_revision IS NOT NULL AS blocked FROM pages WHERE slug = $1 AND source_id = 'default'`, [SLUG]);
      return rows[0]?.blocked ?? null;
    },
  },
  {
    domain: 'tags',
    async seed(engine) {
      await seedPage(engine);
      await engine.addTag(SLUG, 'seeded-tag');
    },
    async write(tx) {
      await tx.addTag(SLUG, 'rolled-back-tag');
    },
    async observe(engine) {
      return engine.getTags(SLUG, { sourceId: 'default' });
    },
  },
  {
    domain: 'links',
    async seed(engine) {
      await seedPage(engine);
      await engine.putPage(LINK_TARGET, { type: 'note', title: 'Rollback link target', compiled_truth: 'target' });
      await engine.addLink(SLUG, LINK_TARGET, 'seeded context', 'mentions', 'manual');
    },
    async write(tx) {
      await tx.addLink(SLUG, LINK_TARGET, 'rolled-back context', 'mentions', 'manual');
    },
    async observe(engine) {
      return (await engine.getLinks(SLUG, { sourceId: 'default' }))
        .filter((l) => l.to_slug === LINK_TARGET).map((l) => `${l.link_type}:${l.context}`).sort();
    },
  },
  {
    domain: 'timeline',
    async seed(engine) {
      await seedPage(engine);
      await engine.addTimelineEntry(SLUG, { date: '2026-01-02', source: 'test:rollback', summary: 'seeded entry' });
    },
    async write(tx) {
      expect(await tx.addTimelineEntry(SLUG, { date: '2026-01-03', source: 'test:rollback', summary: 'rolled-back entry' })).toBe(true);
    },
    async observe(engine) {
      return (await engine.getTimeline(SLUG, { sourceId: 'default' })).map((e) => e.summary).sort();
    },
  },
  {
    domain: 'page-body (stageSegmentTexts)',
    async seed(engine) { await seedSegmentedPage(engine, SEGMENTED_SLUG); },
    async write(tx) { expect(await tx.stageSegmentTexts('default', [ROLLBACK_TEXT])).toEqual({ inserted: 1 }); },
    observe: engine => segmentTextExists(engine, ROLLBACK_TEXT),
  },
  {
    domain: 'page-body (stageManifestRows)',
    async seed(engine) {
      await seedSegmentedPage(engine, SEGMENTED_SLUG);
      await engine.stageSegmentTexts('default', [MANIFEST_TEXT]);
      await seedStaging(engine, MANIFEST_STAGING_ID);
    },
    async write(tx) {
      const [occurrenceId] = await tx.allocateBodyOccurrenceIds(1);
      await tx.stageManifestRows([manifestRow({ pageId: await segmentedPageId(tx, SEGMENTED_SLUG), occurrenceId: occurrenceId!, genFrom: 2, seq: 0,
        text: MANIFEST_TEXT, byteStart: 0, stagingId: MANIFEST_STAGING_ID })]);
    },
    async observe(engine) { return (await engine.readManifest(await segmentedPageId(engine, SEGMENTED_SLUG), { stagingId: MANIFEST_STAGING_ID })).length; },
  },
  {
    domain: 'page-body (stageSegmentChunks)',
    async seed(engine) { await seedSegmentedPage(engine, SEGMENTED_SLUG); },
    async write(tx) {
      const [occurrenceId] = await tx.allocateBodyOccurrenceIds(1);
      await tx.stageSegmentChunks(await segmentedPageId(tx, SEGMENTED_SLUG), 99, [chunk(occurrenceId!, 0, 'rolled-back staged chunk')]);
    },
    async observe(engine) {
      const rows = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE page_id = $1 AND body_generation = 99',
        [await segmentedPageId(engine, SEGMENTED_SLUG)]);
      return Number(rows[0]?.n ?? 0);
    },
  },
  {
    domain: 'page-body (createSegmentedPageShell)',
    async seed() {},
    async write(tx) { await tx.createSegmentedPageShell(SHELL_SLUG, pageMeta(), { sourceId: 'default' }); },
    async observe(engine) {
      const rows = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE slug = $1 AND source_id = 'default'", [SHELL_SLUG]);
      return Number(rows[0]?.n ?? 0);
    },
  },
  {
    domain: 'page-body (flipBodyGeneration)',
    async seed(engine) {
      await seedSegmentedPage(engine, FLIP_SLUG);
      const pageId = await segmentedPageId(engine, FLIP_SLUG);
      if (await openStagingOf(engine, FLIP_SLUG)) return;
      await stageGeneration(engine, { pageId, slug: FLIP_SLUG, genFrom: 2, texts: [FLIP_TEXT] });
    },
    async write(tx) {
      const pageId = await segmentedPageId(tx, FLIP_SLUG);
      const live = await tx.readManifest(pageId);
      expect(await tx.flipBodyGeneration(flipInput(pageId, 1, (await openStagingOf(tx, FLIP_SLUG))!, [FLIP_TEXT],
        { closeOccurrences: live.map(r => r.occurrenceId) }))).toEqual({ retiredChunks: 0, retireDeferred: false });
    },
    async observe(engine) {
      const rows = await engine.executeRaw<{ g: number }>("SELECT body_generation::int AS g FROM pages WHERE slug = $1 AND source_id = 'default'", [FLIP_SLUG]);
      return Number(rows[0]?.g ?? -1);
    },
  },
  {
    domain: 'page-body (openBodyStaging)',
    async seed(engine) { await seedSegmentedPage(engine, SEGMENTED_SLUG); },
    async write(tx) { await tx.openBodyStaging(stagingInput({ id: OPENED_STAGING_ID, slug: SEGMENTED_SLUG })); },
    observe: engine => stagingState(engine, OPENED_STAGING_ID),
  },
  {
    domain: 'page-body (setBodyStagingState)',
    async seed(engine) { await seedStaging(engine, STATE_STAGING_ID); },
    async write(tx) { await tx.setBodyStagingState(STATE_STAGING_ID, 'aborted'); },
    observe: engine => stagingState(engine, STATE_STAGING_ID),
  },
  {
    domain: 'page-body (sweepSegments)',
    async seed(engine) {
      await seedSegmentedPage(engine, SEGMENTED_SLUG);
      await engine.stageSegmentTexts('default', [ORPHAN_TEXT]);
      await engine.executeRaw("UPDATE page_segment_texts SET created_at = now() - interval '2 hours' WHERE source_id = 'default' AND sha256 = decode($1, 'hex')",
        [hexOf(ORPHAN_TEXT.sha256)]);
    },
    async write(tx) {
      expect((await tx.sweepSegments({ sourceId: 'default' })).textsDeleted).toBeGreaterThanOrEqual(1);
    },
    observe: engine => segmentTextExists(engine, ORPHAN_TEXT),
  },
];

const SEGMENTED_SLUG = 'notes/engine-sql-rollback-segmented-alice-example';
const FLIP_SLUG = 'notes/engine-sql-rollback-flip-alice-example';
const SHELL_SLUG = 'notes/engine-sql-rollback-shell-alice-example';
const ROLLBACK_TEXT = segmentText('# Rollback\nstaged text that never commits\n');
const MANIFEST_TEXT = segmentText('# Rollback\nmanifest probe text\n');
const FLIP_TEXT = segmentText('# Rollback\nflipped body\n');
const ORPHAN_TEXT = segmentText('# Rollback\nunreferenced aged text\n');
const MANIFEST_STAGING_ID = '6d1f1c2a-8b6e-4a59-9c39-2f0b6d4a0001';
const OPENED_STAGING_ID = '6d1f1c2a-8b6e-4a59-9c39-2f0b6d4a0002';
const STATE_STAGING_ID = '6d1f1c2a-8b6e-4a59-9c39-2f0b6d4a0003';

async function segmentedPageId(engine: BrainEngine, slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'", [slug]);
  return Number(rows[0]?.id ?? 0);
}

async function seedSegmentedPage(engine: BrainEngine, slug: string): Promise<void> {
  if (await segmentedPageId(engine, slug)) return;
  await publishSegmentedPage(engine, slug, [segmentText(`# ${slug}\nbase body\n`)]);
}

async function seedStaging(engine: BrainEngine, id: string): Promise<void> {
  await seedSegmentedPage(engine, SEGMENTED_SLUG);
  if (await stagingState(engine, id)) return;
  await engine.openBodyStaging(stagingInput({ id, slug: SEGMENTED_SLUG, pageId: await segmentedPageId(engine, SEGMENTED_SLUG) }));
}

async function stagingState(engine: BrainEngine, id: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id = $1::uuid', [id]);
  return rows[0]?.state ?? null;
}

async function openStagingOf(engine: BrainEngine, slug: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ id: string }>("SELECT id::text AS id FROM page_body_stagings WHERE slug = $1 AND state = 'open' ORDER BY created_at LIMIT 1", [slug]);
  return rows[0]?.id ?? null;
}

async function segmentTextExists(engine: BrainEngine, text: { sha256: Uint8Array }): Promise<boolean> {
  return (await engine.readSegmentTexts('default', [text.sha256])).has(hexOf(text.sha256));
}

async function chunkTexts(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ t: string }>(
    `SELECT cc.chunk_text AS t FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = $1 AND p.source_id = 'default' ORDER BY cc.chunk_index`, [SLUG]);
  return rows.map((r) => r.t);
}

const EMBEDDED_TEXT = 'embedded chunk';
const CURRENT_MODEL = 'openai:text-embedding-3-large';
const RETIRED_MODEL = 'rollback:retired-model';

/** SLUG with one sealed chunk embedded through the real upsert, no contextual mode, no signature. */
async function seedEmbeddedChunk(engine: BrainEngine, model = CURRENT_MODEL): Promise<void> {
  await seedPage(engine);
  await engine.executeRaw(`UPDATE pages SET contextual_retrieval_mode = NULL, embedding_signature = NULL
    WHERE slug = $1 AND source_id = 'default'`, [SLUG]);
  await installFixtureChunks(engine, SLUG, [{ chunk_index: 0, chunk_text: EMBEDDED_TEXT, chunk_source: 'compiled_truth', model }]);
  const vector = new Float32Array(await embeddingDims(engine));
  vector[0] = 1;
  await engine.upsertChunks(SLUG, [{ chunk_index: 0, chunk_text: EMBEDDED_TEXT, chunk_source: 'compiled_truth', embedding: vector, model }]);
  expect(await vectorState(engine)).toEqual({ missing: false, pending: false });
}

async function embeddingDims(engine: BrainEngine): Promise<number> {
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0`);
  return Number(rows[0].dim);
}

/** A signature for a model the seeded chunk was not embedded with. */
async function swapSignature(engine: BrainEngine): Promise<string> {
  return `rollback:swapped-model:${await embeddingDims(engine)}`;
}

async function vectorState(engine: BrainEngine): Promise<{ missing: boolean; pending: boolean } | null> {
  const rows = await engine.executeRaw<{ missing: boolean; pending: boolean }>(
    `SELECT cc.embedding IS NULL AS missing, cc.embedding_pending_since IS NOT NULL AS pending
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = $1 AND p.source_id = 'default' AND cc.chunk_index = 0`, [SLUG]);
  return rows[0] ? { missing: rows[0].missing, pending: rows[0].pending } : null;
}

async function pendingStamp(engine: BrainEngine): Promise<boolean | null> {
  return (await vectorState(engine))?.pending ?? null;
}

async function rollbackChunk(engine: BrainEngine): Promise<number> {
  const existing = await engine.getChunks(SLUG);
  if (existing.length > 0) return existing[0]!.id;
  await installFixtureChunks(engine, SLUG, [{
    chunk_index: 0, chunk_text: 'body', chunk_source: 'compiled_truth',
    language: 'typescript', symbol_name: 'run', symbol_type: 'function', symbol_name_qualified: 'run',
  }]);
  return (await engine.getChunks(SLUG))[0]!.id;
}

async function pageId(engine: BrainEngine): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'`, [SLUG]);
  return Number(rows[0].id);
}

class Rollback extends Error {}

/** Register one test per case and transaction entry point. */
export function defineRollbackCases(opts: {
  getEngine: () => BrainEngine;
  entryPoints: ReadonlyArray<'transaction' | 'transactionDirect'>;
  concurrentPoolRead: boolean;
}): void {
  for (const c of ROLLBACK_CASES) {
    for (const entry of opts.entryPoints) {
      test(`${c.domain}: a write through engine.${entry}() that then throws is rolled back`, async () => {
        const engine = opts.getEngine();
        await c.seed(engine);
        const before = await c.observe(engine);
        const err = await engine[entry](async (tx) => {
          await c.write(tx);
          expect(await c.observe(tx)).not.toEqual(before);
          if (opts.concurrentPoolRead) expect(await c.observe(engine)).toEqual(before);
          throw new Rollback('rollback probe');
        }).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(Rollback);
        expect(await c.observe(engine)).toEqual(before);
      }, 15_000);
    }
  }
}
