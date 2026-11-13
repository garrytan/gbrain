/**
 * W3 (GBRA-224, #7212): health's embed_coverage counts the same live,
 * eligible chunks as missing_embeddings and the stale paths. Chunks retained
 * on a soft-deleted page no longer lower coverage; a live unembedded page
 * still does, embed_skip pages stay out, and a source scope is kept. Real
 * PGLite and, with DATABASE_URL, Postgres; repo-less brains.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../src/core/search/embedding-column.ts';

const backends = testBackends();
const engines: Array<{ name: string; engine: BrainEngine; reset: () => Promise<void> }> = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema();
    const version = await engine.getConfig('version');
    engines.push({ name: 'pglite', engine, reset: async () => { await resetPgliteState(engine); if (version) await engine.setConfig('version', version); } });
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    closePostgres = pg.close;
    engines.push({ name: 'postgres', engine: pg.engine, reset: async () => { await pg.engine.executeRaw('DELETE FROM pages'); } });
  }
}, 120_000);

afterAll(async () => {
  for (const { engine, name } of engines) if (name === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

async function seed(engine: BrainEngine, slug: string, embedded: boolean, sourceId = 'default'): Promise<void> {
  if (sourceId !== 'default') await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [sourceId]);
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` }, { sourceId });
  await engine.upsertChunks(slug, [0, 1].map(i => ({ chunk_index: i, chunk_text: `${slug} chunk ${i}`, chunk_source: 'compiled_truth' as const, token_count: 4 })), { sourceId });
  if (!embedded) return;
  const column = (await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name;
  const [{ dim }] = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = $1 AND attnum > 0`, [column]);
  await engine.executeRaw(
    `UPDATE content_chunks SET "${column}" = ('[' || array_to_string(array_fill(0.1::real, ARRAY[$1::int]), ',') || ']')::vector
      WHERE page_id = (SELECT id FROM pages WHERE slug = $2 AND source_id = $3)`, [Number(dim), slug, sourceId]);
}

for (const backend of backends) {
  test(`[${backend}] coverage excludes chunks retained on soft-deleted pages; live gaps, embed_skip and source scope still count right`, async () => {
    const { engine, reset } = engines.find(e => e.name === backend)!;
    await reset();
    await seed(engine, 'notes/live-one', true);
    await seed(engine, 'notes/live-two', true);
    await seed(engine, 'notes/deleted-unembedded', false);
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/deleted-unembedded'`);
    const retained = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks WHERE page_id = (SELECT id FROM pages WHERE slug = 'notes/deleted-unembedded')`);
    expect(retained[0]!.n).toBe(2);

    let health = await engine.getHealth();
    expect(health.missing_embeddings).toBe(0);
    expect(health.embed_coverage).toBe(1);
    expect(await engine.countStaleChunks()).toBe(0);
    expect(await engine.listStaleChunks({ batchSize: 10 })).toEqual([]);

    await seed(engine, 'notes/skipped-unembedded', false);
    await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"embed_skip": true}'::jsonb WHERE slug = 'notes/skipped-unembedded'`);
    expect((await engine.getHealth()).embed_coverage).toBe(1);

    await seed(engine, 'notes/live-gap', false, 'source-b');
    health = await engine.getHealth();
    expect(health.missing_embeddings).toBe(2);
    expect(health.embed_coverage).toBeCloseTo(4 / 6, 5);
    expect((await engine.getHealth({ sourceId: 'default' })).embed_coverage).toBe(1);
    expect((await engine.getHealth({ sourceId: 'source-b' })).embed_coverage).toBe(0);
  }, 60_000);
}
