import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTakes } from '../src/commands/takes.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { saveConfig } from '../src/core/config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'cli-refresh';
const OTHER = 'other-src';
const MODEL = 'ollama:EmbeddingGemma:latest';
const DIMS = 1536;
let root: string;
let engine: PGLiteEngine;
let server: ReturnType<typeof Bun.serve>;
let wire: string[][] = [];
const config = () => ({ engine: 'pglite' as const, database_path: join(root, 'db'), embedding_disabled: false,
  embedding_model: MODEL, embedding_dimensions: DIMS });
const inHome = <T>(run: () => Promise<T>) => withEnv({ GBRAIN_HOME: root, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined,
  DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, run);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-take-refresh-cli-'));
  await inHome(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ embedding_model: MODEL, embedding_dimensions: DIMS } as never);
    await engine.initSchema();
  });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { input?: string[] };
    wire.push([...(body.input ?? [])]);
    return Response.json({ object: 'list', model: 'EmbeddingGemma:latest',
      data: (body.input ?? []).map((_, index) => ({ object: 'embedding', embedding: Array(DIMS).fill(0.25), index })),
      usage: { prompt_tokens: (body.input ?? []).length, total_tokens: (body.input ?? []).length } });
  } });
});

beforeEach(async () => inHome(async () => {
  await resetPgliteState(engine);
  saveConfig(config());
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS,
    base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` }, env: {} });
  await engine.setConfig('embedding_model', MODEL);
  await engine.setConfig('embedding_dimensions', String(DIMS));
  await engine.setConfig('embedding_disabled', 'false');
  await engine.setConfig('pricing.overrides', '{"ollama:embeddinggemma:latest":1}');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SOURCE]);
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [OTHER]);
  wire = [];
}));

afterEach(() => resetGateway());
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function seed(claims = ['First take', 'Second take'], sourceId = SOURCE) {
  const page = await engine.putPage('takes/refresh', { type: 'note', title: 'Refresh', compiled_truth: 'Refresh fixture' }, { sourceId });
  await engine.addTakesBatch(claims.map((claim, index) => ({ page_id: page.id, row_num: index + 1, claim,
    kind: 'take', holder: 'self', weight: 0.8 })));
}

async function call(args: string[]) {
  return inHome(() => runTakes(engine, ['embed', ...args]));
}

test('refresh preview is source scoped, read-only and reports its JSON contract', async () => {
  await seed();
  await seed(['Other source take'], OTHER);
  const output: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => { output.push(values.join(' ')); };
  try { await call(['--all', '--source-id', SOURCE, '--dry-run', '--json']); }
  finally { console.log = original; }
  expect(JSON.parse(output.join('\n'))).toMatchObject({ source_id: SOURCE, dryRun: true, would_embed: 2, stopped: 'preview' });
  expect(wire).toEqual([]);
  expect(await engine.executeRaw('SELECT embedding FROM takes WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [SOURCE]))
    .toEqual([{ embedding: null }, { embedding: null }]);
});

test('refresh options reject missing or malformed scope, cap and runtime without changing vectors', async () => {
  await seed();
  await seed(['Other source take'], OTHER);
  for (const args of [
    ['--all'], ['--all', '--source-id', 'Bad_ID'], ['--all', '--source-id', SOURCE, '--budget-ms', '2x'],
    ['--all', '--source-id', SOURCE, '--budget-ms', '3600001'], ['--all', '--source-id', SOURCE, '--max-cost-usd', 'NaN'],
    ['--source-id', SOURCE, '--yes'],
  ]) await expect(call(args)).rejects.toThrow();
  expect(wire).toEqual([]);
  expect(await engine.executeRaw('SELECT embedding FROM takes WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [SOURCE]))
    .toEqual([{ embedding: null }, { embedding: null }]);
});

test('approved all refresh rejects a trailing runtime flag before invalidating vectors', async () => {
  await seed();
  await expect(call(['--all', '--source-id', SOURCE, '--yes', '--max-cost-usd', '1', '--budget-ms'])).rejects.toThrow('--budget-ms requires a value');
  expect(wire).toEqual([]);
  expect(await engine.executeRaw('SELECT embedding FROM takes')).toEqual([{ embedding: null }, { embedding: null }]);
});

test('approved all refresh rejects a trailing batch flag before invalidating vectors', async () => {
  await seed();
  await expect(call(['--all', '--source-id', SOURCE, '--yes', '--max-cost-usd', '1', '--batch-size'])).rejects.toThrow('--batch-size requires a value');
  expect(wire).toEqual([]);
  expect(await engine.executeRaw('SELECT embedding FROM takes')).toEqual([{ embedding: null }, { embedding: null }]);
});

test('preview rejects a trailing spend cap instead of dropping it', async () => {
  await seed();
  await expect(call(['--all', '--source-id', SOURCE, '--max-cost-usd'])).rejects.toThrow('--max-cost-usd requires a value');
  expect(wire).toEqual([]);
  expect(await engine.executeRaw('SELECT embedding FROM takes')).toEqual([{ embedding: null }, { embedding: null }]);
});

test('approved source refresh resumes stale takes while preserving completed vectors', async () => {
  await seed();
  await seed(['Other source take'], OTHER);
  await call(['--source-id', SOURCE, '--yes', '--max-cost-usd', '1']);
  expect(wire.flat()).toEqual(['title: none | text: First take', 'title: none | text: Second take']);
  const [kept] = await engine.executeRaw<{ embedding: string }>(
    'SELECT t.embedding::text AS embedding FROM takes t JOIN pages p ON p.id=t.page_id WHERE t.row_num=1 AND p.source_id=$1', [SOURCE]);
  await engine.executeRaw("UPDATE takes SET claim='Changed take' WHERE row_num=2");
  wire = [];
  await call(['--source-id', SOURCE, '--yes', '--max-cost-usd', '1']);
  expect(wire.flat()).toEqual(['title: none | text: Changed take']);
  expect(await engine.executeRaw(
    'SELECT t.embedding::text AS embedding FROM takes t JOIN pages p ON p.id=t.page_id WHERE t.row_num=1 AND p.source_id=$1', [SOURCE]))
    .toEqual([kept]);
});

test('approved --all refresh re-embeds completed vectors after preflight', async () => {
  await seed();
  await seed(['Other source take'], OTHER);
  await call(['--source-id', SOURCE, '--yes', '--max-cost-usd', '1']);
  wire = [];
  await call(['--all', '--source-id', SOURCE, '--yes', '--max-cost-usd', '1']);
  expect(wire.flat()).toEqual(['title: none | text: First take', 'title: none | text: Second take']);
  expect(await engine.executeRaw('SELECT count(*)::int AS count FROM takes WHERE embedding IS NOT NULL AND embedding_model=$1', [MODEL]))
    .toEqual([{ count: 2 }]);
  expect(await engine.executeRaw('SELECT embedding FROM takes WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [OTHER]))
    .toEqual([{ embedding: null }]);
});

test('an exhausted spend cap returns a non-success result instead of claiming completion', async () => {
  await seed();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { errors.push(values.join(' ')); };
  try {
    await expect(call(['--source-id', SOURCE, '--yes', '--max-cost-usd', '0'])).rejects.toThrow('takes refresh failed');
  } finally { console.error = original; }
  expect(errors.join('\n')).toContain('Take refresh failed');
  expect(errors.join('\n')).not.toContain('Refreshed');
  expect(wire).toEqual([]);
});

test('legacy dry-run output and source-scoped embed path remain intact', async () => {
  await seed();
  const output: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => { output.push(values.join(' ')); };
  try { await call(['--source-id', SOURCE, '--dry-run']); }
  finally { console.log = original; }
  expect(output.join('\n')).toContain('[dry-run] Would embed 2 active take(s)');
  expect(wire).toEqual([]);
});
