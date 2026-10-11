import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { reindexCodeProjection } from '../src/core/persistence/projection-reindex.ts';

const sourceId = 'embedding-document-code-projection-test';
const dims = 1536;
const code = 'export function beta() { return 3; }\nexport function alpha() { return beta(); }\n';
const gemma = 'ollama:embeddinggemma:300m';
let engine: BrainEngine;
let server: ReturnType<typeof Bun.serve>;
let holdNextRequest = false;
let requestStarted: (() => void) | undefined;
let releaseRequest: (() => void) | undefined;
let requests: { input: string[]; model: string }[];

beforeAll(async () => {
  const pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  engine = pglite;
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as { input: string[]; model: string };
    requests.push(body);
    if (holdNextRequest) {
      holdNextRequest = false;
      requestStarted?.();
      await new Promise<void>(resolve => { releaseRequest = resolve; });
    }
    return Response.json({ object: 'list', model: body.model,
      data: body.input.map((_, index) => ({ object: 'embedding', index, embedding: Array(dims).fill(0.1) })) });
  } });
}, 120_000);

beforeEach(async () => {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  requests = [];
});

afterEach(async () => {
  releaseRequest?.();
  releaseRequest = undefined;
  requestStarted = undefined;
  holdNextRequest = false;
  await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
  resetGateway();
});

afterAll(async () => {
  server?.stop(true);
  await (engine as PGLiteEngine).disconnect();
});

async function seed(path: string, title?: string) {
  const result = await importCodeFile(engine, path, code, { sourceId, noEmbed: true });
  if (title !== undefined) await setTitle(result.slug, path, title);
  return result.slug;
}

async function setTitle(slug: string, path: string, title: string) {
  await engine.putPage(slug, { type: 'code', page_kind: 'code', title, compiled_truth: code,
    timeline: '', frontmatter: { language: 'typescript', file: path }, tags: ['code', 'typescript'], source_path: path }, { sourceId });
}

function configure(model: string) {
  configureGateway({ embedding_model: model, embedding_dimensions: dims, env: {},
    base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` } });
}

async function storedProof(slug: string) {
  return engine.executeRaw<{ embedded: boolean; proof: string | null }>(
    `SELECT embedding IS NOT NULL AS embedded,embedding_input_hash AS proof FROM content_chunks
      WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2) ORDER BY chunk_index`, [sourceId, slug]);
}

test('code reindex sends the stored title and persists its formatted embedding proof', async () => {
  configure(gemma);
  const slug = await seed('projection/title.ts');
  const page = await engine.getPage(slug, { sourceId });
  expect(page?.title).toBe('projection/title.ts (typescript)');

  expect(await reindexCodeProjection(engine, slug, sourceId, { force: true })).toMatchObject({ status: 'imported' });

  const chunks = await engine.getChunks(slug, { sourceId });
  expect(requests.flatMap(request => request.input).sort()).toEqual(chunks.map(chunk =>
    `title: ${page!.title} | text: ${chunk.chunk_text}`).sort());
  expect(requests.map(request => request.model)).toEqual(['embeddinggemma:300m']);
  expect((await storedProof(slug)).every(row => row.embedded && row.proof)).toBe(true);
});

test('code reindex uses none for a blank title and leaves other models raw', async () => {
  configure(gemma);
  const untitled = await seed('projection/untitled.ts', '');
  await reindexCodeProjection(engine, untitled, sourceId, { force: true });
  const untitledChunks = await engine.getChunks(untitled, { sourceId });
  expect(requests.flatMap(request => request.input).sort()).toEqual(untitledChunks.map(chunk =>
    `title: none | text: ${chunk.chunk_text}`).sort());

  requests = [];
  const model = 'ollama:nomic-embed-text';
  configure(model);
  const raw = await seed('projection/raw.ts');
  await reindexCodeProjection(engine, raw, sourceId, { force: true });
  const rawChunks = await engine.getChunks(raw, { sourceId });
  expect(requests.flatMap(request => request.input).sort()).toEqual(rawChunks.map(chunk => chunk.chunk_text).sort());
  expect((await storedProof(raw)).every(row => row.embedded && row.proof)).toBe(true);
});

test('a title edit during the embedding request discards vectors and proof for the old snapshot', async () => {
  configure(gemma);
  const slug = await seed('projection/stale.ts');
  const before = await engine.getPage(slug, { sourceId });
  holdNextRequest = true;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const reindex = reindexCodeProjection(engine, slug, sourceId, { force: true }).then(
    () => null, error => error,
  );

  await started;
  await setTitle(slug, 'projection/stale.ts', 'Changed while embedding');
  releaseRequest?.();
  releaseRequest = undefined;

  const error = await reindex;
  expect(error).toMatchObject({ code: 'revision_conflict' });
  expect((await engine.getPage(slug, { sourceId }))?.knowledge_revision).not.toBe(before?.knowledge_revision);
  const discarded = await storedProof(slug);
  expect(discarded.length).toBeGreaterThan(0);
  expect(discarded.every(row => !row.embedded && row.proof === null)).toBe(true);
});
