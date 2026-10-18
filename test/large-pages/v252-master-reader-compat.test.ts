/**
 * The released chunk readers keep working on a schema this branch migrated (Wave B PR 2, mixed-version window).
 *
 * 1. Protects: a process still running the released binary (master's chunkGenerationFilter, which names
 *    content_chunks.retired_generation) reads chunks of a brain whose schema this branch migrated through v252,
 *    with segmented storage on or off; v252 keeps the column (nothing at head writes or reads it) and still
 *    builds the GC index.
 * 2. Fails when: v252 drops retired_generation before the writer floor excludes every binary whose search,
 *    get_chunks or embed queue selects it (they fail with 42703 on ordinary search).
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. The filter text is copied verbatim from
 *    origin/master 3ed487d2 src/core/search/safe-chunks.ts, so the probe does not move when head's filter changes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';

function masterChunkGenerationFilter(page: string, chunk: string): string {
  return `(${chunk}.body_generation IS NULL
       OR (${chunk}.body_generation <= ${page}.body_generation
           AND (${chunk}.retired_generation IS NULL OR ${chunk}.retired_generation > ${page}.body_generation)))`;
}
function masterChunkGenerationProbe(chunk: string): string {
  return `(${chunk}.body_generation IS NULL
       OR EXISTS (SELECT 1 FROM pages gp WHERE gp.id = ${chunk}.page_id AND ${masterChunkGenerationFilter('gp', chunk)}))`;
}
function masterChunkVisibleFilter(page: string, chunk: string): string {
  return `((${page}.text_projection_revision = ${page}.knowledge_revision) IS TRUE AND ${masterChunkGenerationFilter(page, chunk)})`;
}

function sections(tag: string, n = 60): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(`## Section ${tag}${i}\n\n` + `Paragraph ${i} of ${tag} about widgets and gadgets number ${i}. `.repeat(400) + '\n\n');
  return parts.join('');
}
const page = (body: string) => `---\ntitle: Mixed version\ntype: note\n---\n\n${body}`;

for (const kind of testBackends()) {
  describe(`v252 keeps the column master's chunk readers select (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    for (const storage of ['off', 'on'] as const) {
      test(`master's search, chunk read and embed-queue predicates run on the migrated schema (segmented storage ${storage})`, async () => {
        await engine.setConfig('pages.segmented_storage', storage);
        const slug = `notes/mixed-${storage}`;
        await importFromContent(engine, slug, page(sections(storage)), { sourceId: 'default', noEmbed: true });
        const row = await segmentedPageRow(engine, slug);
        expect(row.body_storage).toBe(storage === 'on' ? 'segmented' : 'inline');
        const [visible] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id = c.page_id
          WHERE p.id = $1 AND ${masterChunkVisibleFilter('p', 'c')}`, [row.id]);
        expect(Number(visible!.n)).toBeGreaterThan(0);
        const [probed] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks c
          WHERE c.page_id = $1 AND ${masterChunkGenerationProbe('c')}`, [row.id]);
        expect(Number(probed!.n)).toBe(Number(visible!.n));
        const [keyword] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id = c.page_id
          WHERE p.id = $1 AND c.search_vector @@ plainto_tsquery('english', 'widgets') AND ${masterChunkVisibleFilter('p', 'c')}`, [row.id]);
        expect(Number(keyword!.n)).toBeGreaterThan(0);
      }, 120_000);
    }

    test('v252 builds the GC index and leaves retired_generation in place', async () => {
      const [column] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'content_chunks' AND column_name = 'retired_generation'`);
      expect(Number(column!.n)).toBe(1);
      const [index] = await engine.executeRaw<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'content_chunks_generation_idx'");
      expect(index?.indexdef).toContain('WHERE (body_generation IS NOT NULL)');
    }, 60_000);
  });
}
