/**
 * #203 — invalid and cancelled full page refreshes never gain formatted provenance.
 * Uses persisted PGLite state and the real loopback Ollama transport so the
 * assertions cover the boundary between model responses and accepted writes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEmbedCore } from '../src/commands/embed.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { embeddingInputContext, embeddingWriteTarget } from '../src/core/page-state/projections.ts';
import { embeddingInputHash } from '../src/core/embedding-input-hash.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const MODEL = 'ollama:embeddinggemma:300m';
const MODEL_ID = 'embeddinggemma:300m';
const DIMS = 1536;
const SIGNATURE = `${MODEL}:${DIMS}`;
const pages = [
  { slug: 'refresh-safety/refused', title: 'Refused page', body: 'body to refuse', legacy: 0.05 },
  { slug: 'refresh-safety/healthy', title: 'Healthy page', body: 'body to refresh', legacy: 0.06 },
];

let engine: PGLiteEngine;
let server: ReturnType<typeof Bun.serve>;
let home: string;
let requests: Array<{ input: string[]; model: string }>;
let holdNextResponse = false;
let requestStarted: (() => void) | undefined;
let releaseHeldResponse: (() => void) | undefined;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as { input: string[]; model: string };
    requests.push(body);
    if (holdNextResponse) {
      holdNextResponse = false;
      requestStarted?.();
      await new Promise<void>(resolve => { releaseHeldResponse = resolve; });
    }
    const invalid = body.input.some(input => input.includes('body to refuse'));
    const value = invalid ? 0 : 0.2;
    return Response.json({ object: 'list', model: body.model,
      data: body.input.map((_, index) => ({ object: 'embedding', index, embedding: Array(DIMS).fill(value) })),
      usage: { prompt_tokens: body.input.length, total_tokens: body.input.length } });
  } });
}, 30000);

beforeEach(async () => {
  await resetPgliteState(engine);
  home = mkdtempSync(join(tmpdir(), 'embedding-document-refresh-safety-'));
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite', embedding_model: MODEL, embedding_dimensions: DIMS,
  }));
  await engine.setConfig('embedding_model', MODEL);
  await engine.setConfig('embedding_dimensions', String(DIMS));
  await engine.setConfig('embedding_disabled', 'false');
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: {},
    base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` } });
  requests = [];
  holdNextResponse = false;
  requestStarted = undefined;
  releaseHeldResponse = undefined;
});

afterEach(() => {
  resetGateway();
  rmSync(home, { recursive: true, force: true });
});

afterAll(async () => {
  await engine.disconnect();
  server?.stop(true);
});

async function seedLegacyPage(page: typeof pages[number]) {
  await engine.putPage(page.slug, { type: 'note', title: page.title, compiled_truth: page.body });
  await installFixtureChunks(engine, page.slug, [{ chunk_index: 0, chunk_text: page.body,
    chunk_source: 'compiled_truth', embedding: new Float32Array(DIMS).fill(page.legacy), model: MODEL }]);
  await engine.setPageEmbeddingSignature(page.slug, { sourceId: 'default', signature: SIGNATURE });
  await engine.executeRaw(`UPDATE content_chunks SET embedding_input_hash=NULL
    WHERE page_id=(SELECT id FROM pages WHERE slug=$1 AND source_id='default')`, [page.slug]);
}

async function storedRows() {
  return engine.executeRaw<{ slug: string; embedding: string | null; model: string | null;
    signature: string | null; embedding_input_hash: string | null; body: string; chunk_text: string }>(
    `SELECT p.slug,cc.embedding::text AS embedding,cc.model,p.embedding_signature AS signature,
            cc.embedding_input_hash,p.compiled_truth AS body,cc.chunk_text
       FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
      WHERE p.slug LIKE 'refresh-safety/%' ORDER BY p.slug`);
}

function isZeroVector(vector: string | null) {
  return vector !== null && /^\[0(?:,0)*\]$/.test(vector);
}

async function expectedProof(page: typeof pages[number]) {
  const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: 'default' });
  const chunks = await engine.getChunks(page.slug, { sourceId: 'default' });
  const target = await embeddingWriteTarget(engine);
  return embeddingInputHash(embeddingInputContext(target, snapshot!.page.title,
    snapshot!.page.corpus_generation ?? null, chunks), 'none', chunks[0]!);
}

test('full refresh refuses a zero vector without stamping its proof and still refreshes a healthy neighbor', async () => {
  await seedLegacyPage(pages[0]!);
  await seedLegacyPage(pages[1]!);
  const legacy = await storedRows();
  expect(legacy).toHaveLength(2);
  expect(legacy.every(row => row.embedding !== null && row.model === MODEL
    && row.signature === SIGNATURE && row.embedding_input_hash === null)).toBe(true);

  const result = await withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined,
    GBRAIN_EMBEDDING_DIMENSIONS: undefined, GBRAIN_EMBED_CONCURRENCY: '1' }, () =>
    runEmbedCore(engine, { all: true, quiet: true }));

  expect(result.failures).toBeGreaterThan(0);
  expect(requests.map(request => request.model)).toEqual([MODEL_ID, MODEL_ID]);
  const after = await storedRows();
  const refused = after.find(row => row.slug === pages[0]!.slug)!;
  const healthy = after.find(row => row.slug === pages[1]!.slug)!;
  expect(refused.body).toBe(pages[0]!.body);
  expect(refused.chunk_text).toBe(pages[0]!.body);
  expect(isZeroVector(refused.embedding)).toBe(false);
  expect(refused.embedding_input_hash).toBeNull();
  expect(healthy.body).toBe(pages[1]!.body);
  expect(healthy.chunk_text).toBe(pages[1]!.body);
  expect(healthy.embedding).not.toBeNull();
  const healthyVector = healthy.embedding!.slice(1, -1).split(',').map(Number);
  expect(healthyVector).toHaveLength(DIMS);
  expect(healthyVector.every(value => value === 0.2)).toBe(true);
  expect(healthy.embedding_input_hash).toBe(await expectedProof(pages[1]!));
});

test('a held full-refresh response arriving after cancellation cannot change persisted state', async () => {
  const page = pages[1]!;
  await seedLegacyPage(page);
  const legacy = await storedRows();
  expect(legacy).toHaveLength(1);
  expect(legacy[0]!.embedding).not.toBeNull();
  expect(legacy[0]!.model).toBe(MODEL);
  expect(legacy[0]!.signature).toBe(SIGNATURE);
  expect(legacy[0]!.embedding_input_hash).toBeNull();
  holdNextResponse = true;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  requestStarted = started;

  const controller = new AbortController();
  const operation = withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined,
    GBRAIN_EMBEDDING_DIMENSIONS: undefined, GBRAIN_EMBED_CONCURRENCY: '1' }, () =>
    runEmbedCore(engine, { all: true, quiet: true, signal: controller.signal }));
  try {
    await Promise.race([startedPromise, operation.then(() => {
      throw new Error('Full refresh completed without starting the held HTTP request');
    })]);
    controller.abort();
    const atCancellation = await storedRows();
    expect(atCancellation[0]!.body).toBe(page.body);
    expect(atCancellation[0]!.chunk_text).toBe(page.body);
    expect(atCancellation[0]!.embedding_input_hash).toBeNull();

    releaseHeldResponse?.();
    await operation;
    expect(await storedRows()).toEqual(atCancellation);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe(MODEL_ID);
  } finally {
    releaseHeldResponse?.();
    await operation;
  }
});
