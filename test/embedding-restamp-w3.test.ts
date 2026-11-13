/**
 * W3 (GBRA-224, #5527 class): the free signature restamp. A page whose chunks
 * all hold current-model vectors but whose stored signature is missing or
 * names another model gets the current signature with no provider call. The
 * stamp is guarded: a content edit or chunk rewrite between the read and the
 * stamp makes it match nothing (round-2 T16), and content and vectors never
 * change. Bounded per run, switchable, audited; repeated failures escalate to
 * doctor's embedding_restamp_stalled. Real PGLite and, with DATABASE_URL,
 * Postgres. These brains have no git repository (repo-less).
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../src/core/search/embedding-column.ts';
import { __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { restampCurrentSpaceSignatures, __setRestampBeforeStampForTests, EMBEDDING_RESTAMP_ENABLED_KEY,
  EMBEDDING_RESTAMP_FAILURE_BOUND, EMBEDDING_RESTAMP_CODE } from '../src/core/embedding-restamp.ts';
import { readHealAudit } from '../src/core/heal-audit.ts';
import { embeddingRestampStalledCheck } from '../src/commands/doctor/checks/embedding-restamp.ts';

const backends = testBackends();
const engines: Array<{ name: string; engine: BrainEngine; reset: () => Promise<void> }> = [];
let closePostgres: (() => Promise<void>) | undefined;
let embedCalls = 0;
const MODEL = 'openai:example-embedding';

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
    engines.push({ name: 'postgres', engine: pg.engine, reset: async () => {
      await pg.engine.executeRaw('DELETE FROM pages');
      await pg.engine.executeRaw('DELETE FROM config WHERE key = ANY($1::text[])', [['heal.audit', EMBEDDING_RESTAMP_ENABLED_KEY]]);
    } });
  }
  __setEmbedTransportForTests((async () => { embedCalls++; throw new Error('no provider call expected'); }) as never);
}, 120_000);

afterEach(() => { __setRestampBeforeStampForTests(null); });
afterAll(async () => {
  __setEmbedTransportForTests(null);
  for (const { engine, name } of engines) if (name === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

async function activeDims(engine: BrainEngine): Promise<{ column: string; dims: number }> {
  const column = (await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name;
  const [row] = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = $1 AND attnum > 0`, [column]);
  return { column, dims: Number(row!.dim) };
}

async function seedPage(engine: BrainEngine, slug: string, dims: number, opts: { signature?: string; chunks?: number } = {}): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nbody of ${slug}` });
  await installFixtureChunks(engine, slug, Array.from({ length: opts.chunks ?? 2 }, (_, i) => ({
    chunk_index: i, chunk_text: `${slug} chunk ${i}`, chunk_source: 'compiled_truth' as const,
    embedding: new Float32Array(dims).fill(0.25), model: MODEL })));
  if (opts.signature) await engine.setPageEmbeddingSignature(slug, { signature: opts.signature });
}

const signatureOf = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ s: string | null }>(
  `SELECT embedding_signature AS s FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug]))[0]?.s ?? null;

async function vectorsAndContent(engine: BrainEngine, column: string): Promise<string> {
  const rows = await engine.executeRaw<{ v: string }>(
    `SELECT string_agg(p.slug || ':' || p.knowledge_revision::text || ':' || md5(cc.chunk_text) || ':' || md5(cc."${column}"::text) || ':' || COALESCE(cc.embedded_text_hash, ''), '|' ORDER BY p.slug, cc.chunk_index) AS v
       FROM pages p JOIN content_chunks cc ON cc.page_id = p.id`);
  return rows[0]!.v;
}

for (const backend of backends) {
  const ctx = () => engines.find(e => e.name === backend)!;

  test(`[${backend}] stamps only pages whose every chunk is current, with zero provider requests and no content or vector change`, async () => {
    const { engine, reset } = ctx(); await reset();
    const { column, dims } = await activeDims(engine);
    const signature = `${MODEL}:${dims}`;
    await seedPage(engine, 'notes/unstamped', dims);
    await seedPage(engine, 'notes/old-signature', dims, { signature: 'openai:retired-model:1536' });
    await seedPage(engine, 'notes/already-current', dims, { signature });
    await seedPage(engine, 'notes/foreign-chunk', dims, { signature: 'openai:retired-model:1536' });
    await engine.executeRaw(`UPDATE content_chunks SET model = 'openai:retired-model' WHERE chunk_index = 1
      AND page_id = (SELECT id FROM pages WHERE slug = 'notes/foreign-chunk')`);
    await seedPage(engine, 'notes/skipped', dims);
    await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"embed_skip": true}'::jsonb WHERE slug = 'notes/skipped'`);
    await seedPage(engine, 'notes/deleted', dims);
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/deleted'`);
    const before = await vectorsAndContent(engine, column);
    embedCalls = 0;

    const result = (await restampCurrentSpaceSignatures(engine, signature))!;
    expect(result).toMatchObject({ pages: 2, chunks: 4, rejected: 0, capped: false, failed_runs: 0 });
    expect(embedCalls).toBe(0);
    expect(await signatureOf(engine, 'notes/unstamped')).toBe(signature);
    expect(await signatureOf(engine, 'notes/old-signature')).toBe(signature);
    expect(await signatureOf(engine, 'notes/foreign-chunk')).toBe('openai:retired-model:1536');
    expect(await signatureOf(engine, 'notes/skipped')).toBeNull();
    expect(await signatureOf(engine, 'notes/deleted')).toBeNull();
    expect(await vectorsAndContent(engine, column)).toBe(before);
    expect((await readHealAudit(engine, EMBEDDING_RESTAMP_CODE)).at(-1)).toMatchObject({ outcome: 'restamped', attempt: 0 });
    expect((await restampCurrentSpaceSignatures(engine, signature))!.pages).toBe(0);
  }, 60_000);

  test(`[${backend}] a content edit or chunk rewrite between the read and the stamp makes the stamp match nothing (T16)`, async () => {
    const { engine, reset } = ctx(); await reset();
    const { column, dims } = await activeDims(engine);
    const signature = `${MODEL}:${dims}`;
    await seedPage(engine, 'notes/edited', dims, { signature: 'openai:retired-model:1536' });
    await seedPage(engine, 'notes/rewritten', dims, { signature: 'openai:retired-model:1536' });
    const ids = Object.fromEntries((await engine.executeRaw<{ id: number; slug: string }>(`SELECT id, slug FROM pages`)).map(r => [r.slug, Number(r.id)]));
    __setRestampBeforeStampForTests(async pageId => {
      // The signature stays the same in both cases: only the content generation moves.
      if (pageId === ids['notes/edited']) await engine.putPage('notes/edited', { type: 'note', title: 'notes/edited', compiled_truth: '# edited\n\nnew body' });
      if (pageId === ids['notes/rewritten']) await engine.executeRaw(`UPDATE content_chunks SET chunk_text = chunk_text || ' (rewritten)' WHERE page_id = $1 AND chunk_index = 0`, [pageId]);
    });
    const before = await vectorsAndContent(engine, column);
    const result = (await restampCurrentSpaceSignatures(engine, signature))!;
    expect(result).toMatchObject({ pages: 0, rejected: 2 });
    expect(await signatureOf(engine, 'notes/edited')).toBe('openai:retired-model:1536');
    expect(await signatureOf(engine, 'notes/rewritten')).toBe('openai:retired-model:1536');
    __setRestampBeforeStampForTests(null);
    expect(await vectorsAndContent(engine, column)).not.toBe(before);
    const after = await vectorsAndContent(engine, column);
    await restampCurrentSpaceSignatures(engine, signature);
    expect(await vectorsAndContent(engine, column)).toBe(after);
    expect(await signatureOf(engine, 'notes/rewritten')).toBe('openai:retired-model:1536');
  }, 60_000);

  test(`[${backend}] bounded per run, off by switch, and repeated failures escalate to doctor then clear`, async () => {
    const { engine, reset } = ctx(); await reset();
    const { dims } = await activeDims(engine);
    const signature = `${MODEL}:${dims}`;
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) await seedPage(engine, slug, dims, { chunks: 1 });

    await engine.setConfig(EMBEDDING_RESTAMP_ENABLED_KEY, 'false');
    expect(await restampCurrentSpaceSignatures(engine, signature)).toBeNull();
    expect(await signatureOf(engine, 'notes/a')).toBeNull();
    expect((await embeddingRestampStalledCheck(engine)).status).toBe('ok');
    await engine.setConfig(EMBEDDING_RESTAMP_ENABLED_KEY, 'true');

    expect(await restampCurrentSpaceSignatures(engine, signature, { maxPages: 2 })).toMatchObject({ pages: 2, capped: true, max_pages: 2 });
    expect(await signatureOf(engine, 'notes/c')).toBeNull();

    __setRestampBeforeStampForTests(async () => { throw new Error('simulated stamp failure'); });
    for (let attempt = 1; attempt <= EMBEDDING_RESTAMP_FAILURE_BOUND; attempt++) {
      expect((await embeddingRestampStalledCheck(engine)).status).toBe('ok');
      expect(await restampCurrentSpaceSignatures(engine, signature)).toMatchObject({ failed_runs: attempt, error: 'simulated stamp failure' });
    }
    const stalled = await embeddingRestampStalledCheck(engine);
    expect(stalled.status).toBe('warn');
    expect(stalled.message).toContain('simulated stamp failure');
    expect((await readHealAudit(engine, EMBEDDING_RESTAMP_CODE)).at(-1)).toMatchObject({ outcome: 'escalated', attempt: EMBEDDING_RESTAMP_FAILURE_BOUND });

    __setRestampBeforeStampForTests(null);
    expect(await restampCurrentSpaceSignatures(engine, signature)).toMatchObject({ pages: 1, capped: false, failed_runs: 0 });
    expect(await signatureOf(engine, 'notes/c')).toBe(signature);
    expect((await embeddingRestampStalledCheck(engine)).status).toBe('ok');
    expect(embedCalls).toBe(0);
  }, 60_000);
}
