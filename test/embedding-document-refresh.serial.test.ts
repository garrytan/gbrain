/**
 * #199 — explicit full refresh upgrades legacy raw EmbeddingGemma vectors.
 *
 * Authoring gate:
 * 1. Protects the operator-visible refresh contract: ordinary stale work and
 *    a verified same-model migration preserve valid legacy vectors without
 *    claiming formatted-input provenance; `--all` replaces them with vectors
 *    built from the stored title and body and stamps the matching v2 proof.
 * 2. Fails if ordinary recovery starts certifying legacy vectors, if the
 *    explicit all path reuses them, or if a resumed full refresh skips pages
 *    that completed before interruption.
 * 3. Uses the existing PGLite fixture, runEmbedCore, migration command, and a
 *    loopback Ollama HTTP capture; no product seam or provider mock is added.
 * 4. Serial because configureGateway and the environment are process-global,
 *    and this test binds the fake Ollama endpoint.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runEmbedCore } from '../src/commands/embed.ts';
import { runMigrateEmbeddings } from '../src/commands/migrate-embeddings.ts';
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
  { slug: 'refresh/first', title: 'First stored title', body: 'first stored body', legacy: 0.05 },
  { slug: 'refresh/second', title: 'Second stored title', body: 'second stored body', legacy: 0.06 },
];
const documentInput = (title: string, body: string) => `title: ${title} | text: ${body}`;

class ExitSignal extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

let engine: PGLiteEngine;
let server: ReturnType<typeof Bun.serve>;
let home: string;
let requests: Array<{ input: string[]; model: string }>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as { input: string[]; model: string };
    requests.push(body);
    const value = 0.1 + requests.length / 10;
    return Response.json({ object: 'list', model: body.model,
      data: body.input.map((_, index) => ({ object: 'embedding', index, embedding: Array(DIMS).fill(value) })),
      usage: { prompt_tokens: body.input.length, total_tokens: body.input.length } });
  } });
}, 30000);

beforeEach(async () => {
  await resetPgliteState(engine);
  home = mkdtempSync(join(tmpdir(), 'embedding-document-refresh-'));
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
});

afterEach(() => {
  resetGateway();
  rmSync(home, { recursive: true, force: true });
});

afterAll(async () => {
  await engine.disconnect();
  server?.stop(true);
});

async function seedLegacyVectors() {
  for (const page of pages) {
    await engine.putPage(page.slug, { type: 'note', title: page.title, compiled_truth: page.body });
    await installFixtureChunks(engine, page.slug, [{ chunk_index: 0, chunk_text: page.body,
      chunk_source: 'compiled_truth', embedding: new Float32Array(DIMS).fill(page.legacy), model: MODEL }]);
    await engine.setPageEmbeddingSignature(page.slug, { sourceId: 'default', signature: SIGNATURE });
  }
  await engine.executeRaw(`UPDATE content_chunks SET embedding_input_hash=NULL
    WHERE page_id IN (SELECT id FROM pages WHERE slug=ANY($1::text[]) AND source_id='default')`, [pages.map(page => page.slug)]);
}

async function storedRows() {
  return engine.executeRaw<{ slug: string; signature: string | null; embedding: string; model: string;
    embedded_text_hash: string; embedding_input_hash: string | null }>(
    `SELECT p.slug,p.embedding_signature AS signature,cc.embedding::text AS embedding,cc.model,
            cc.embedded_text_hash,cc.embedding_input_hash
       FROM content_chunks cc JOIN pages p ON p.id=cc.page_id ORDER BY p.slug`);
}

function vectorValue(vector: string) {
  return Number(vector.slice(1, vector.indexOf(',')));
}

async function expectedProof(page: typeof pages[number]) {
  const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: 'default' });
  const chunks = await engine.getChunks(page.slug, { sourceId: 'default' });
  const target = await embeddingWriteTarget(engine);
  return embeddingInputHash(embeddingInputContext(target, snapshot!.page.title,
    snapshot!.page.corpus_generation ?? null, chunks), 'none', chunks[0]!);
}

test('ordinary reuse stays legacy; explicit full refresh formats, proves, and repeats completed pages after interruption', async () => {
  await seedLegacyVectors();
  const before = await storedRows();
  expect(before).toHaveLength(pages.length);
  expect(before.every(row => row.signature === SIGNATURE && row.embedding_input_hash === null)).toBe(true);

  let interruptedTitle = '';
  await withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined,
    GBRAIN_EMBEDDING_DIMENSIONS: undefined, GBRAIN_EMBED_CONCURRENCY: '1' }, async () => {
    const stale = await runEmbedCore(engine, { stale: true, catchUp: true, takes: false, quiet: true });
    expect(stale.embedded).toBe(0);
    expect(requests).toEqual([]);

    let migrationExit = -1;
    const migrationOutput: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      migrationOutput.push(args.join(' '));
    });
    try {
      await runMigrateEmbeddings(engine, ['--to', MODEL, '--dim', String(DIMS), '--reranker', 'keep', '--json'], {
        exit: code => { throw new ExitSignal(code); },
      });
    } catch (error) {
      if (!(error instanceof ExitSignal)) throw error;
      migrationExit = error.code;
    } finally {
      logSpy.mockRestore();
    }
    expect(migrationExit).toBe(0);
    expect(JSON.parse(migrationOutput[0]!).status).toBe('skipped_no_work');
    expect(requests).toEqual([]);

    const afterOrdinaryRuns = await storedRows();
    expect(afterOrdinaryRuns).toEqual(before);

    const controller = new AbortController();
    const interrupted = await runEmbedCore(engine, { all: true, quiet: true, signal: controller.signal,
      onProgress: done => { if (done === 1) controller.abort(); } });
    expect(interrupted.embedded).toBe(1);
    expect(requests).toHaveLength(1);

    interruptedTitle = requests[0]!.input[0]!;
    const completedPage = pages.find(page => interruptedTitle === documentInput(page.title, page.body));
    if (!completedPage) throw new Error(`Unexpected interrupted request: ${interruptedTitle}`);
    const afterInterruptedRefresh = await storedRows();
    const installed = afterInterruptedRefresh.find(row => row.slug === completedPage.slug)!;
    const oldInstalled = before.find(row => row.slug === completedPage.slug)!;
    expect(installed.embedding).not.toBe(oldInstalled.embedding);
    expect(vectorValue(installed.embedding)).toBeCloseTo(0.2, 6);
    expect(installed.signature).toBe(SIGNATURE);
    expect(installed.model).toBe(MODEL);
    expect(installed.embedding_input_hash).toBe(await expectedProof(completedPage));
    expect(installed.embedded_text_hash).toBe(createHash('md5').update(completedPage.body).digest('hex'));
    for (const untouched of pages.filter(page => page.slug !== completedPage.slug)) {
      expect(afterInterruptedRefresh.find(row => row.slug === untouched.slug)).toEqual(
        before.find(row => row.slug === untouched.slug));
    }
    const retryStart = requests.length;
    const resumed = await runEmbedCore(engine, { all: true, quiet: true });
    expect(resumed.embedded).toBe(pages.length);
    const retryInputs = requests.slice(retryStart).flatMap(request => request.input);
    expect(retryInputs.sort()).toEqual(pages.map(page => documentInput(page.title, page.body)).sort());
    expect(retryInputs).toContain(interruptedTitle);
  });

  const refreshed = await storedRows();
  expect(requests.every(request => request.model === MODEL_ID)).toBe(true);
  expect(requests.flatMap(request => request.input).sort()).toEqual([
    ...pages.map(page => documentInput(page.title, page.body)),
    interruptedTitle,
  ].sort());
  for (const page of pages) {
    const row = refreshed.find(item => item.slug === page.slug)!;
    expect(row.signature).toBe(SIGNATURE);
    expect(row.model).toBe(MODEL);
    expect(row.embedding_input_hash).toBe(await expectedProof(page));
    expect(row.embedding_input_hash).not.toBeNull();
    expect(row.embedded_text_hash).toBeTruthy();
    expect(vectorValue(row.embedding)).toBeGreaterThan(page.legacy);
  }
});
