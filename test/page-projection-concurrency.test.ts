import { beforeAll, afterAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { installPageProjection, installPageEmbeddings, readProjectionSnapshot, rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { PageRevisionConflictError } from '../src/core/page-state/types.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const sourceId = 'projection-concurrency-test';
const page = (body: string) => ({ type: 'note', title: 'Example projection', compiled_truth: body, frontmatter: {} });
const chunk = (body: string) => [{ chunk_index: 0, chunk_source: 'compiled_truth' as const, chunk_text: body }];

beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({});
  await lite.initSchema();
  engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine);
    closePostgres = pg.close;
  }
  for (const engine of engines) {
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) {
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    if (engine.kind === 'pglite') await engine.disconnect();
  }
  await closePostgres?.();
});

test('unsealed chunks stay hidden for local and remote reads until a verified replacement', async () => {
  for (const engine of engines) {
    await engine.putPage('seal', page('stalesentinel'), { sourceId });
    await engine.upsertChunks('seal', chunk('stalesentinel'), { sourceId });
    expect(await engine.getChunks('seal', { sourceId })).toEqual([]);
    expect(await engine.searchKeyword('stalesentinel', { sourceId })).toEqual([]);
    expect(await engine.searchTitles('projection', { sourceId })).toEqual([]);
    const snapshot = (await readProjectionSnapshot(engine, 'seal', sourceId, { allowUnsealed: true }))!;
    await installPageProjection(engine, snapshot, chunk('stalesentinel'), { seal: true });
    expect(await engine.getChunks('seal', { sourceId })).toHaveLength(1);
    expect(await engine.getChunks('seal', { sourceId, requireSafeChunks: true })).toHaveLength(1);
    expect(await engine.searchKeyword('stalesentinel', { sourceId })).toHaveLength(1);
    await engine.putPage('seal', page('freshsentinel'), { sourceId });
    expect(await engine.getChunks('seal', { sourceId })).toEqual([]);
    expect(await engine.searchKeyword('stalesentinel', { sourceId })).toEqual([]);
    await expect(installPageProjection(engine, snapshot, chunk('stalesentinel'), { seal: true })).rejects.toBeInstanceOf(PageRevisionConflictError);
  }
});

test('withdrawal commits revision, removes stale retrieval, and durably rebuilds without a filesystem owner', async () => {
  const claim = 'withdrawnsentinel example fact';
  const fence = `<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 | | test | |\n<!--- gbrain:facts:end -->`;
  for (const engine of engines) {
    await engine.putPage('withdraw', { ...page('Safe prose'), timeline: fence }, { sourceId });
    const before = (await engine.readPageSnapshot('withdraw', { sourceId }))!;
    await installPageProjection(engine, (await readProjectionSnapshot(engine, 'withdraw', sourceId, { allowUnsealed: true }))!, chunk(claim), { seal: true });
    const fact = await engine.insertFact({ fact: claim, source: 'test', visibility: 'world' }, { source_id: sourceId });
    const result = await recordFactWithdrawal(engine, fact.id, sourceId, true);
    expect(result.withdrawn).toBe(true);
    const current = (await engine.readPageSnapshot('withdraw', { sourceId }))!;
    expect(current.revision).not.toBe(before.revision);
    expect(current.page.timeline).toContain(`~~${claim}~~`);
    expect(sanitizeRemoteBody(current.page.timeline)).not.toContain(claim);
    expect(await engine.getChunks('withdraw', { sourceId })).toEqual([]);
    expect(await engine.searchKeyword('withdrawnsentinel', { sourceId })).toEqual([]);
    expect(await engine.executeRaw('SELECT slug FROM page_projection_jobs WHERE slug=$1', ['withdraw'])).not.toHaveLength(0);
    const second = await recordFactWithdrawal(engine, fact.id, sourceId, true);
    expect(second.withdrawn).toBe(false);
    expect((await engine.readPageSnapshot('withdraw', { sourceId }))!.revision).toBe(current.revision);
    expect((await rebuildPendingPageProjections(engine, 100)).rebuilt).toBeGreaterThan(0);
    const rebuilt = await engine.getChunks('withdraw', { sourceId });
    expect(rebuilt.length).toBeGreaterThan(0);
    expect(rebuilt.map(c => c.chunk_text).join('\n')).not.toContain(claim);
    expect(await engine.executeRaw('SELECT slug FROM page_projection_jobs WHERE slug=$1', ['withdraw'])).toHaveLength(0);
    expect(await engine.searchKeyword('withdrawnsentinel', { sourceId })).toEqual([]);
    expect(await engine.searchTitles('withdrawnsentinel', { sourceId })).toEqual([]);
    await engine.executeRaw('UPDATE pages SET last_retrieved_at=now() WHERE source_id=$1 AND slug=$2', [sourceId,'withdraw']);
    expect(await engine.searchTitles('withdrawnsentinel', { sourceId })).toEqual([]);
  }
});

test('delayed embeddings cannot replace new chunks at the same indices', async () => {
  for (const engine of engines) {
    await engine.putPage('embedding-race', page('Before embedding'), { sourceId });
    await installPageProjection(engine, (await readProjectionSnapshot(engine, 'embedding-race', sourceId, { allowUnsealed: true }))!, chunk('Before embedding'), { seal: true });
    const prepared = (await readProjectionSnapshot(engine, 'embedding-race', sourceId))!;
    await engine.putPage('embedding-race', page('After embedding'), { sourceId });
    const current = (await readProjectionSnapshot(engine, 'embedding-race', sourceId, { allowUnsealed: true }))!;
    await installPageProjection(engine, current, chunk('After embedding'), { seal: true });
    expect(await installPageEmbeddings(engine, prepared, chunk('Before embedding'))).toBe(false);
    expect((await engine.getChunks('embedding-race', { sourceId }))[0].chunk_text).toBe('After embedding');
    // Even an unchanged logical revision cannot accept a stale chunk layout.
    const sameRevision = (await readProjectionSnapshot(engine, 'embedding-race', sourceId))!;
    await installPageProjection(engine, sameRevision, chunk('A re-chunked snapshot'), { seal: true });
    expect(await installPageEmbeddings(engine, sameRevision, chunk('After embedding'))).toBe(false);
  }
});


test('embedding completion updates only vectors and rejects an indexing-context change', async () => {
  for (const engine of engines) {
    await engine.putPage('embedding-completion', page('Stable text'), { sourceId });
    await installPageProjection(engine, (await readProjectionSnapshot(engine, 'embedding-completion', sourceId, { allowUnsealed: true }))!, chunk('Stable text'), { seal: true });
    const prepared = (await readProjectionSnapshot(engine, 'embedding-completion', sourceId))!;
    const vector = new Float32Array(1536); vector[0] = 1;
    expect(await installPageEmbeddings(engine, prepared, [{ ...chunk('Stable text')[0], embedding: vector }])).toBe(true);
    const current = (await readProjectionSnapshot(engine, 'embedding-completion', sourceId))!;
    expect(current.chunks.map(c => [c.id,c.chunk_text,c.chunk_index])).toEqual(prepared.chunks.map(c => [c.id,c.chunk_text,c.chunk_index]));
    const [stored] = await engine.executeRaw<{ hash: string; matches: boolean }>('SELECT embedded_text_hash AS hash,embedded_text_hash=md5(chunk_text) AS matches FROM content_chunks WHERE id=$1', [current.chunks[0].id]);
    expect(stored.matches).toBe(true);
    const old = await engine.getConfig('contextual_retrieval.mode');
    try {
      await engine.setConfig('contextual_retrieval.mode', 'projection-test-changed');
      expect(await installPageEmbeddings(engine, prepared, [{ ...chunk('Stable text')[0], embedding: vector }])).toBe(false);
    } finally {
      if (old !== null) await engine.setConfig('contextual_retrieval.mode', old);
      else await engine.executeRaw("DELETE FROM config WHERE key='contextual_retrieval.mode'");
    }
  }
});

test('embedding completion stamps the captured full model and rejects a runtime model change', async () => {
  try {
    for (const engine of engines) {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: {} });
      await engine.putPage('embedding-model', page('Model provenance'), { sourceId });
      await installPageProjection(engine, (await readProjectionSnapshot(engine, 'embedding-model', sourceId, { allowUnsealed: true }))!, chunk('Model provenance'), { seal: true });
      const prepared = (await readProjectionSnapshot(engine, 'embedding-model', sourceId))!;
      const vector = new Float32Array(1536); vector[0] = 1;
      expect(await installPageEmbeddings(engine, prepared, [{ ...chunk('Model provenance')[0], embedding: vector }])).toBe(true);
      const [stored] = await engine.executeRaw<{ model: string }>('SELECT model FROM content_chunks WHERE id=$1', [prepared.chunks[0].id]);
      expect(stored.model).toBe('openai:text-embedding-3-small');
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      expect(await installPageEmbeddings(engine, prepared, [{ ...chunk('Model provenance')[0], embedding: vector }])).toBe(false);
      expect((await engine.executeRaw<{ model: string }>('SELECT model FROM content_chunks WHERE id=$1', [prepared.chunks[0].id]))[0].model).toBe(stored.model);
      const current = (await readProjectionSnapshot(engine, 'embedding-model', sourceId))!;
      expect(await installPageEmbeddings(engine, current, [{ ...chunk('Model provenance')[0], embedding: vector, model: 'fixture:explicit-model' }])).toBe(true);
      expect((await engine.executeRaw<{ model: string }>('SELECT model FROM content_chunks WHERE id=$1', [prepared.chunks[0].id]))[0].model).toBe('fixture:explicit-model');
    }
  } finally { resetGateway(); }
});
