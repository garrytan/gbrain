/**
 * Lane: unit. Run: `bun test test/embedding-document-fact-budget.test.ts`.
 * Protects that fact repair reserves the formatted title:none request before
 * sending, then sends raw facts through the gateway exactly once. Reverting
 * the budget change admits a cap that should refuse; existing formatter tests
 * do not cover the backfill's reservation boundary. Uses the existing gateway
 * transport seam, with no production-only seam.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { saveConfig } from '../src/core/config.ts';
import { embedStaleFacts } from '../src/core/embed-facts.ts';
import { withEnv } from './helpers/with-env.ts';

const sourceId = 'embedding-document-fact-budget';
let root: string;
let engine: PGLiteEngine;
let wire: string[][];
let server: ReturnType<typeof Bun.serve>;
const config = () => ({ engine: 'pglite' as const, database_path: join(root, 'db'), embedding_disabled: false });
const inHome = <T>(run: () => Promise<T>) => withEnv({
  GBRAIN_HOME: root, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined,
  DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
}, run);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-fact-document-budget-'));
  await inHome(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_path: config().database_path });
    await engine.initSchema();
    await engine.executeRaw('ALTER TABLE facts ALTER COLUMN embedding TYPE halfvec(768) USING embedding::halfvec(768)');
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { input?: string[] };
    wire.push([...(body.input ?? [])]);
    return Response.json({ object: 'list', model: 'EmbeddingGemma:latest',
      data: (body.input ?? []).map((_, index) => ({ object: 'embedding', embedding: Array(768).fill(0.25), index })),
      usage: { prompt_tokens: (body.input ?? []).length, total_tokens: (body.input ?? []).length } });
  } });
});

beforeEach(async () => inHome(async () => {
  saveConfig(config());
  configureGateway({ embedding_model: 'ollama:EmbeddingGemma:latest', embedding_dimensions: 768,
    base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` }, env: {} });
  await engine.executeRaw('DELETE FROM facts WHERE source_id=$1', [sourceId]);
  await engine.setConfig('embedding_model', 'ollama:EmbeddingGemma:latest');
  await engine.setConfig('embedding_dimensions', '768');
  await engine.setConfig('embedding_disabled', 'false');
  await engine.setConfig('pricing.overrides', '{"ollama:embeddinggemma:latest":1}');
  wire = [];
}));

afterEach(async () => inHome(async () => {
  resetGateway();
}));

afterAll(async () => {
  await inHome(() => engine.disconnect());
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function seed(fact: string) {
  await engine.insertFact({ fact, source: 'notes', visibility: 'world', kind: 'fact', confidence: 1 }, { source_id: sourceId });
}

test('fact budget includes title:none before dispatch and gateway formats the raw fact once', () => inHome(async () => {
  await seed('x');

  const refused = await embedStaleFacts(engine, { sourceId, yes: true, maxCostUsd: 0.00001 }, config());
  expect(refused).toMatchObject({ embedded: 0, failures: 1, stopped: 'failed' });
  expect(wire).toEqual([]);

  const admitted = await embedStaleFacts(engine, { sourceId, yes: true, maxCostUsd: 1 }, config());
  expect(admitted).toMatchObject({ embedded: 1, remaining: 0, failures: 0 });
  expect(wire).toEqual([['title: none | text: x']]);
}));
