import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { runEmbedCore } from '../src/commands/embed.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const MODEL = 'ollama:embeddinggemma:300m';
const OTHER_MODEL = 'openai:text-embedding-3-small';
const DIMS = 1536;
const doc = (title: string, text: string) => `title: ${title} | text: ${text}`;
let engine: PGLiteEngine;
let server: ReturnType<typeof Bun.serve>;
let requests: { input: string[]; model: string }[];
let otherModelInputs: string[];
let failNextBatch = false;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as { input: string[]; model: string };
    requests.push(body);
    if (failNextBatch && body.input.length > 1) {
      failNextBatch = false;
      return Response.json({ error: { message: 'batch rejected permanently' } }, { status: 400 });
    }
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
  otherModelInputs = [];
  failNextBatch = false;
});

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

afterAll(async () => {
  await engine.disconnect();
  server?.stop(true);
});

async function seed(slug: string, title: string, texts: string[]) {
  await engine.putPage(slug, { type: 'note', title, compiled_truth: texts.join('\n\n') });
  await installFixtureChunks(engine, slug, texts.map((chunk_text, chunk_index) => ({
    chunk_index, chunk_text, chunk_source: 'compiled_truth',
  })));
}

function recordedInputs() {
  return requests.flatMap(request => request.input);
}

test('manual single-page route keeps its title and stored chunk body through failure fanout', async () => {
  await seed('manual/fanout', 'Manual title', ['first stored body', 'second stored body']);
  failNextBatch = true;

  const result = await runEmbedCore(engine, { slug: 'manual/fanout', quiet: true });

  expect(result.embedded).toBe(2);
  const expected = [doc('Manual title', 'first stored body'), doc('Manual title', 'second stored body')];
  expect(recordedInputs()).toEqual([...expected, ...expected]);
  expect(requests.map(request => request.model)).toEqual(Array(3).fill('embeddinggemma:300m'));
});

test('manual all route sends stored and blank titles', async () => {
  await seed('manual/all-titled', 'All route title', ['all route body']);
  await seed('manual/all-untitled', '', ['untitled body']);

  const result = await runEmbedCore(engine, { all: true, quiet: true });

  expect(result.embedded).toBe(2);
  expect(recordedInputs().sort()).toEqual([
    doc('All route title', 'all route body'),
    doc('none', 'untitled body'),
  ].sort());
});

test('manual stale route sends the stored title', async () => {
  await seed('manual/stale', 'Stale route title', ['stale route body']);

  const result = await runEmbedCore(engine, { stale: true, catchUp: true, takes: false, quiet: true });

  expect(result.embedded).toBe(1);
  expect(recordedInputs()).toEqual([doc('Stale route title', 'stale route body')]);
});

test('manual page route leaves another model input byte-identical', async () => {
  await seed('manual/other-model', 'Available page title', ['title: literal | text: raw body']);
  await engine.setConfig('embedding_model', OTHER_MODEL);
  configureGateway({ embedding_model: OTHER_MODEL, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test-key' } });
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    otherModelInputs.push(...values);
    return { embeddings: values.map(() => Array(DIMS).fill(0.1)), usage: { tokens: values.length } } as never;
  });

  const result = await runEmbedCore(engine, { slug: 'manual/other-model', quiet: true });

  expect(result.embedded).toBe(1);
  expect(otherModelInputs).toEqual(['title: literal | text: raw body']);
  expect(requests).toEqual([]);
});
