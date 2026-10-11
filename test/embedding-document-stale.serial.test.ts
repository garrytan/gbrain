import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { embedStaleForSource, embedStalePages } from '../src/core/embed-stale.ts';
import type { EmbedBatchWithBackoffOpts } from '../src/core/embed-retry.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const MODEL = 'ollama:embeddinggemma:300m';
const MODEL_ID = 'embeddinggemma:300m';
const DIMS = 1536;
const SIGNATURE = `${MODEL}:${DIMS}`;
const doc = (title: string, text: string) => `title: ${title} | text: ${text}`;
let engine: PGLiteEngine;
let server: ReturnType<typeof Bun.serve>;
let requests: { input: string[]; model: string }[];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as { input: string[]; model: string };
    requests.push(body);
    return Response.json({ object: 'list', model: body.model,
      data: body.input.map((_, index) => ({ object: 'embedding', index, embedding: Array(DIMS).fill(0.1) })),
      usage: { prompt_tokens: body.input.length, total_tokens: body.input.length } });
  } });
}, 30000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('embedding_model', MODEL);
  await engine.setConfig('embedding_dimensions', String(DIMS));
  await engine.setConfig('embedding_disabled', 'false');
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: {},
    base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` } });
  requests = [];
});

afterEach(() => resetGateway());

afterAll(async () => {
  await engine.disconnect();
  server?.stop(true);
});

async function seed(slug: string, title: string, chunkText: string, embedding?: Float32Array) {
  await engine.putPage(slug, { type: 'note', title, compiled_truth: chunkText });
  await installFixtureChunks(engine, slug, [{
    chunk_index: 0,
    chunk_text: chunkText,
    chunk_source: 'compiled_truth',
    ...(embedding && { embedding, model: MODEL }),
  }]);
}

function recordedInputs() {
  return requests.flatMap(request => request.input).sort();
}

test('source and page stale fallbacks send stored titles, untitled pages, and tagged models over Ollama HTTP', async () => {
  await seed('source/titled', 'Stored source title', 'source titled chunk');
  await seed('source/untitled', '', 'source untitled chunk');
  const sourceResult = await embedStaleForSource(engine, 'default');
  expect(sourceResult.embedded).toBe(2);
  expect(recordedInputs()).toEqual([
    doc('Stored source title', 'source titled chunk'),
    doc('none', 'source untitled chunk'),
  ].sort());
  expect(requests.map(request => request.model)).toEqual(Array(2).fill(MODEL_ID));

  requests = [];
  await seed('page/titled', 'Stored page title', 'page titled chunk');
  await seed('page/untitled', '', 'page untitled chunk');
  const pageResult = await embedStalePages(engine, ['page/titled', 'page/untitled'], 'default');
  expect(pageResult.embedded).toBe(2);
  expect(recordedInputs()).toEqual([
    doc('Stored page title', 'page titled chunk'),
    doc('none', 'page untitled chunk'),
  ].sort());
  expect(requests.map(request => request.model)).toEqual(Array(2).fill(MODEL_ID));
});

test('source and page injected callbacks receive the stored page title as metadata', async () => {
  const seen: EmbedBatchWithBackoffOpts[] = [];
  const embedFn = async (texts: string[], opts: EmbedBatchWithBackoffOpts) => {
    seen.push(opts);
    return texts.map(() => new Float32Array(DIMS).fill(0.1));
  };

  await seed('callback/source', 'Injected source title', 'source callback chunk');
  await embedStaleForSource(engine, 'default', { embedFn });
  await seed('callback/page', 'Injected page title', 'page callback chunk');
  await embedStalePages(engine, ['callback/page'], 'default', { embedFn });

  expect(seen.map(opts => opts.documentTitle)).toEqual(['Injected source title', 'Injected page title']);
  expect(requests).toEqual([]);
});

test('ordinary stale embedding leaves a valid same-signature legacy vector untouched', async () => {
  await seed('legacy/same-signature', 'Legacy title', 'legacy chunk', new Float32Array(DIMS).fill(0.1));
  await engine.setPageEmbeddingSignature('legacy/same-signature', { sourceId: 'default', signature: SIGNATURE });
  await engine.executeRaw(`UPDATE content_chunks SET embedding_input_hash=NULL
    WHERE page_id=(SELECT id FROM pages WHERE slug=$1 AND source_id='default')`, ['legacy/same-signature']);
  const before = await engine.executeRaw<{ embedding: string; model: string; embedded_text_hash: string; embedding_input_hash: string | null }>(
    `SELECT cc.embedding::text AS embedding,cc.model,cc.embedded_text_hash,cc.embedding_input_hash
       FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.slug=$1 AND p.source_id='default'`,
    ['legacy/same-signature'],
  );

  let callbackCalls = 0;
  const result = await embedStaleForSource(engine, 'default', {
    embedFn: async texts => { callbackCalls++; return texts.map(() => new Float32Array(DIMS).fill(0.2)); },
  });
  const after = await engine.executeRaw<{ embedding: string; model: string; embedded_text_hash: string; embedding_input_hash: string | null }>(
    `SELECT cc.embedding::text AS embedding,cc.model,cc.embedded_text_hash,cc.embedding_input_hash
       FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.slug=$1 AND p.source_id='default'`,
    ['legacy/same-signature'],
  );

  expect(result.embedded).toBe(0);
  expect(callbackCalls).toBe(0);
  expect(requests).toEqual([]);
  expect(after).toEqual(before);
  expect(after[0]?.embedding_input_hash).toBeNull();
});
