import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { reembedPageWithContextualRetrieval } from '../src/core/contextual-retrieval-service.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const MODEL = 'ollama:embeddinggemma:300m';
const MODEL_ID = 'embeddinggemma:300m';
const DIMS = 1536;
const doc = (title: string, text: string) => `title: ${title} | text: ${text}`;
const wrapped = (title: string, text: string) => `<context>${title}\n</context>\n${text}`;

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

async function seed(slug: string, title: string, chunks: { text: string; source: 'compiled_truth' | 'fenced_code' }[]) {
  await engine.putPage(slug, { type: 'note', title, compiled_truth: chunks.map(chunk => chunk.text).join('\n') });
  await installFixtureChunks(engine, slug, chunks.map((chunk, chunk_index) => ({
    chunk_index,
    chunk_text: chunk.text,
    chunk_source: chunk.source,
  })));
}

async function reembed(slug: string, mode: 'title' | 'per_chunk_synopsis') {
  return reembedPageWithContextualRetrieval({
    engine,
    pageSlug: slug,
    sourceId: 'default',
    globalMode: mode,
    generateSynopsis: async () => ({ kind: 'success', synopsis: 'Compact synopsis' }),
  });
}

test('contextual re-embedding sends the snapshot title once and keeps canonical chunks unchanged', async () => {
  await seed('contextual/titled', 'Stored page title', [
    { text: 'ordinary body', source: 'compiled_truth' },
    { text: 'const answer = 42;', source: 'fenced_code' },
  ]);
  expect(await reembed('contextual/titled', 'title')).toMatchObject({ kind: 'success', mode_applied: 'title' });
  expect(requests.flatMap(request => request.input)).toEqual([
    doc('Stored page title', wrapped('Stored page title', 'ordinary body')),
    doc('Stored page title', 'const answer = 42;'),
  ]);
  expect(requests.map(request => request.model)).toEqual([MODEL_ID]);
  expect((await engine.getChunks('contextual/titled', { sourceId: 'default' })).map(chunk => chunk.chunk_text))
    .toEqual(['ordinary body', 'const answer = 42;']);

  requests = [];
  await seed('contextual/untitled', '', [{ text: 'untitled body', source: 'compiled_truth' }]);
  expect(await reembed('contextual/untitled', 'title')).toMatchObject({ kind: 'success', mode_applied: 'title' });
  expect(requests.flatMap(request => request.input)).toEqual([doc('none', 'untitled body')]);

  requests = [];
  await seed('contextual/synopsis', 'Synopsis page title', [
    { text: 'summarized body', source: 'compiled_truth' },
    { text: 'function answer() {}', source: 'fenced_code' },
  ]);
  expect(await reembed('contextual/synopsis', 'per_chunk_synopsis'))
    .toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis' });
  expect(requests.flatMap(request => request.input)).toEqual([
    doc('Synopsis page title', '<context>Synopsis page title\nCompact synopsis\n</context>\nsummarized body'),
    doc('Synopsis page title', 'function answer() {}'),
  ]);
  expect((await engine.getChunks('contextual/synopsis', { sourceId: 'default' })).map(chunk => chunk.chunk_text))
    .toEqual(['summarized body', 'function answer() {}']);

  requests = [];
  await engine.setConfig('embedding_model', 'ollama:nomic-embed-text');
  await engine.setConfig('embedding_dimensions', String(DIMS));
  configureGateway({ embedding_model: 'ollama:nomic-embed-text', embedding_dimensions: DIMS, env: {},
    base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` } });
  await seed('contextual/unaffected-provider', 'No Gemma title', [
    { text: 'unaffected provider body', source: 'compiled_truth' },
  ]);
  expect(await reembed('contextual/unaffected-provider', 'title'))
    .toMatchObject({ kind: 'success', mode_applied: 'title' });
  expect(requests.flatMap(request => request.input))
    .toEqual([wrapped('No Gemma title', 'unaffected provider body')]);
  expect(requests.map(request => request.model)).toEqual(['nomic-embed-text']);
});
