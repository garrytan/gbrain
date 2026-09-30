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
import type { BrainEngine } from '../../src/core/engine.ts';
import { installFixtureChunks } from './page-projection.ts';

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
];

async function chunkTexts(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ t: string }>(
    `SELECT cc.chunk_text AS t FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = $1 AND p.source_id = 'default' ORDER BY cc.chunk_index`, [SLUG]);
  return rows.map((r) => r.t);
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
