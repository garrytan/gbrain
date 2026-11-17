/**
 * #5088: `foresights migrate embeddings` used to recreate the HNSW indexes inside
 * the schema transition, before the bulk re-embed, so every vector write went
 * into a live HNSW graph. The transition now restores only the non-ANN
 * dependents and records the HNSW definitions in the migration marker; they
 * are built after the drain, before the marker clears, and a run interrupted
 * at any point resumes without re-embedding finished rows.
 *
 * `.serial`: one temp GBRAIN_HOME and a fake embed transport for the file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { runMigrateEmbeddings } from '../src/commands/migrate-embeddings.ts';
import { MIGRATION_STATE_KEY } from '../src/core/embedding-migration.ts';
import { parseDeferredAnnIndexes } from '../src/core/embedding-ann-build.ts';

const FROM_DIMS = 1024;
const PAGES = ['page-1', 'page-2', 'page-3', 'page-4', 'page-5', 'page-6'];
const PROBE_TEXT = 'foresights embedding migration probe';
const TARGET = 'openai:text-embedding-3-small';

let engine: PGLiteEngine;
let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};
let currentDims = FROM_DIMS;
let failTexts: string[] = [];
let embeddedTexts: string[] = [];
let probeAnn = false;

class ExitError extends Error { constructor(public code: number) { super(`exit ${code}`); } }

async function runMigrate(args: string[]): Promise<number> {
  try {
    await runMigrateEmbeddings(engine, args, { exit: (code: number): never => { throw new ExitError(code); } });
    throw new Error('runMigrateEmbeddings returned without exiting');
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

async function chunkIndexes(): Promise<Array<{ name: string; def: string }>> {
  return engine.executeRaw(`SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE tablename = 'content_chunks' ORDER BY indexname`);
}
const annNames = async () => (await chunkIndexes()).filter(i => /USING hnsw \(embedding /.test(i.def)).map(i => i.name);
const PINNED_ANN = ['idx_facts_embedding_hnsw', 'idx_query_cache_embedding_hnsw', 'idx_takes_embedding_hnsw'];
const pinnedAnnNames = async () => (await engine.executeRaw<{ name: string }>(
  "SELECT indexname AS name FROM pg_indexes WHERE indexname = ANY($1::text[]) ORDER BY indexname", [PINNED_ANN])).map(r => r.name);
const marker = async () => JSON.parse((await engine.getConfig(MIGRATION_STATE_KEY)) ?? 'null');

/** Records the ANN indexes present for each embed call, in order, so drain calls can be told from later smoke-check queries. */
let embedCalls: Array<{ values: string[]; ann: string[] }> = [];
function installTransport(): void {
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    if (values.some(v => failTexts.some(f => v.includes(f)))) throw new Error('fake transport: simulated failure');
    if (probeAnn && values.some(v => v !== PROBE_TEXT)) embedCalls.push({ values, ann: await annNames() });
    for (const v of values) if (v !== PROBE_TEXT) embeddedTexts.push(v);
    return { embeddings: values.map(() => new Array(currentDims).fill(0).map((_, i) => Math.sin(i) * 0.01 + 0.001)), usage: { tokens: values.length * 4 } } as never;
  });
}

/** ANN indexes seen by embed calls up to and including the one that embedded every listed page (the drain). */
function annSeenDuringDrain(pages: string[]): string[] {
  const seen: string[] = [];
  const remaining = new Set(pages);
  for (const call of embedCalls) {
    seen.push(...call.ann);
    for (const page of pages) if (call.values.some(v => v.includes(page))) remaining.delete(page);
    if (remaining.size === 0) return seen;
  }
  throw new Error(`drain never embedded ${[...remaining].join(', ')}`);
}

async function freshBrain(): Promise<void> {
  currentDims = FROM_DIMS;
  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: FROM_DIMS } as never);
  await engine.initSchema();
  for (const slug of PAGES) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\ncontent for ${slug}` });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `chunk text for ${slug}`, chunk_source: 'compiled_truth', token_count: 5 }]);
  }
  expect((await runEmbedCore(engine, { stale: true, quiet: true })).embedded).toBe(PAGES.length);
}

beforeAll(async () => {
  for (const k of ['GBRAIN_HOME', 'GBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_DIMENSIONS', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-ann-deferred-'));
  process.env.GBRAIN_HOME = tmpHome;
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite', embedding_model: 'voyage:voyage-4', embedding_dimensions: FROM_DIMS,
    voyage_api_key: 'voyage-test-fake', openai_api_key: 'sk-test-fake',
  }, null, 2));
  resetGateway();
  configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: FROM_DIMS, env: { VOYAGE_API_KEY: 'voyage-test-fake', OPENAI_API_KEY: 'sk-test-fake' } });
  installTransport();
  await freshBrain();
}, 120_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(tmpHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('migrate embeddings builds ANN indexes after the re-embed (#5088)', () => {
  test('interrupted run: no HNSW index during the drain or after it; btree dependents restored; worklist in the marker', async () => {
    await engine.executeRaw('CREATE INDEX idx_chunks_embedding_custom_l2 ON content_chunks USING hnsw (embedding vector_l2_ops)');
    await engine.executeRaw('CREATE INDEX idx_chunks_embedding_missing_example ON content_chunks (id) WHERE embedding IS NULL');
    expect(await annNames()).toEqual(['idx_chunks_embedding', 'idx_chunks_embedding_custom_l2']);
    expect(await pinnedAnnNames()).toEqual(PINNED_ANN);
    currentDims = 1536;
    failTexts = ['page-4', 'page-5'];
    embeddedTexts = [];
    probeAnn = true;
    const code = await runMigrate(['--to', TARGET, '--yes', '--max-cost-usd', '1']);
    probeAnn = false;
    expect(code).toBe(1);
    expect(embeddedTexts.length).toBe(PAGES.length - 2);
    expect(annSeenDuringDrain(['page-1', 'page-2', 'page-3', 'page-6'])).toEqual([]);
    expect(await annNames()).toEqual([]);
    expect((await chunkIndexes()).map(i => i.name)).toContain('idx_chunks_embedding_missing_example');
    expect(await pinnedAnnNames()).toEqual([]);
    expect((await marker()).deferred_ann_indexes.map((i: { name: string }) => i.name).sort())
      .toEqual(['idx_chunks_embedding', 'idx_chunks_embedding_custom_l2', ...PINNED_ANN]);
  }, 120_000);

  test('resume: re-embeds only the unfinished rows, then builds every recorded ANN index and clears the marker', async () => {
    failTexts = [];
    embeddedTexts = [];
    embedCalls = [];
    probeAnn = true;
    const code = await runMigrate(['--to', TARGET, '--yes', '--max-cost-usd', '1']);
    probeAnn = false;
    expect(code).toBe(0);
    // The two unfinished pages, plus the three completion smoke-check queries.
    expect(embeddedTexts.length).toBe(5);
    expect(embeddedTexts.join(' ')).toContain('page-4');
    expect(embeddedTexts.join(' ')).toContain('page-5');
    expect(annSeenDuringDrain(['page-4', 'page-5'])).toEqual([]);
    expect(await annNames()).toEqual(['idx_chunks_embedding', 'idx_chunks_embedding_custom_l2']);
    expect(await pinnedAnnNames()).toEqual(PINNED_ANN);
    const custom = (await chunkIndexes()).find(i => i.name === 'idx_chunks_embedding_custom_l2')!;
    expect(custom.def).toContain('vector_l2_ops');
    expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeFalsy();
  }, 120_000);

  test('a build that dies part-way keeps the finished index out of the worklist and the next run builds the rest', async () => {
    await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
    await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding_resume_l2');
    const { buildDeferredAnnIndexes } = await import('../src/core/embedding-ann-build.ts');
    let pending = parseDeferredAnnIndexes([
      { name: 'idx_chunks_embedding', def: 'CREATE INDEX idx_chunks_embedding ON public.content_chunks USING hnsw (embedding vector_cosine_ops)' },
      { name: 'idx_chunks_embedding_resume_l2', def: 'CREATE INDEX idx_chunks_embedding_resume_l2 ON public.content_chunks USING hnsw (embedding vector_l2_ops)' },
    ]);
    let killed = false;
    const dying = new Proxy(engine, { get(target, prop, receiver) {
      if (prop === 'executeRaw') return (sql: string, params?: unknown[]) => {
        if (!killed && /resume_l2/.test(sql) && sql.startsWith('CREATE INDEX')) { killed = true; return Promise.reject(new Error('process killed mid-build')); }
        return target.executeRaw(sql, params as never);
      };
      return Reflect.get(target, prop, receiver);
    } }) as PGLiteEngine;
    const io = { targetDims: 1536, readPending: async () => pending, writePending: async (next: typeof pending) => { pending = next; }, log: () => {} };
    await expect(buildDeferredAnnIndexes(dying, io)).rejects.toThrow('process killed mid-build');
    expect(pending.map(p => p.name)).toEqual(['idx_chunks_embedding_resume_l2']);
    const resumed = await buildDeferredAnnIndexes(engine, io);
    expect(resumed.built).toEqual(['idx_chunks_embedding_resume_l2']);
    expect(pending).toEqual([]);
    expect(await annNames()).toContain('idx_chunks_embedding');
    expect(await annNames()).toContain('idx_chunks_embedding_resume_l2');
  }, 60_000);

  test('a 2,048-dimension target completes with no vector HNSW index (cap policy)', async () => {
    await engine.disconnect();
    writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite', embedding_model: 'voyage:voyage-4', embedding_dimensions: FROM_DIMS,
      voyage_api_key: 'voyage-test-fake', openai_api_key: 'sk-test-fake',
    }, null, 2));
    resetGateway();
    configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: FROM_DIMS, env: { VOYAGE_API_KEY: 'voyage-test-fake', OPENAI_API_KEY: 'sk-test-fake' } });
    installTransport();
    await freshBrain();
    currentDims = 2048;
    embeddedTexts = [];
    const code = await runMigrate(['--to', 'voyage:voyage-4-large', '--dim', '2048', '--yes', '--max-cost-usd', '1']);
    expect(code).toBe(0);
    expect(await annNames()).toEqual([]);
    expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeFalsy();
  }, 120_000);
});

describe('deferred ANN worklist parsing (#5088)', () => {
  test('only HNSW definitions over content_chunks.embedding whose name matches are accepted', () => {
    const ok = { name: 'idx_chunks_embedding', def: 'CREATE INDEX idx_chunks_embedding ON public.content_chunks USING hnsw (embedding vector_cosine_ops)' };
    const partial = { name: 'idx_x', def: "CREATE INDEX idx_x ON public.content_chunks USING hnsw (embedding vector_l2_ops) WITH (m='16') WHERE (embedding IS NOT NULL)" };
    expect(parseDeferredAnnIndexes([ok, partial])).toEqual([ok, partial]);
    const facts = { name: 'idx_facts_embedding_hnsw', def: 'CREATE INDEX IF NOT EXISTS idx_facts_embedding_hnsw\n  ON facts USING hnsw (embedding halfvec_cosine_ops)\n  WHERE embedding IS NOT NULL AND expired_at IS NULL' };
    expect(parseDeferredAnnIndexes([facts])).toEqual([]);
    expect(parseDeferredAnnIndexes([facts], ['content_chunks', 'facts'])[0]!.def)
      .toBe('CREATE INDEX IF NOT EXISTS idx_facts_embedding_hnsw ON facts USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL AND expired_at IS NULL');
    expect(parseDeferredAnnIndexes([
      { name: 'idx_chunks_embedding', def: 'CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops); DROP TABLE pages' },
      { name: 'other', def: ok.def },
      { name: 'idx_pages', def: 'CREATE INDEX idx_pages ON pages USING hnsw (embedding vector_cosine_ops)' },
      'not-an-object',
    ])).toEqual([]);
  });
});
