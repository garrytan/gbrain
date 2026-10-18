import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runSchemaTransition, MIGRATION_STATE_KEY, MIGRATION_COMPLETED_KEY } from '../src/core/embedding-migration.ts';
import { executeMigrationFlow, planMigrationFlow, GLOBAL_MIGRATION_LOCK_ID } from '../src/commands/migrate-embeddings.ts';
import { embedStaleFacts } from '../src/core/embed-facts.ts';

const model = 'openai:text-embedding-3-small';
const dimensions = 8;
let engine: PGLiteEngine;
let home: string;
let calls: string[][];

function transport(before?: (values: string[]) => Promise<void>) {
  __setEmbedTransportForTests(async ({ values }) => {
    calls.push([...values]);
    await before?.(values);
    return { values, embeddings: values.map(() => Array(dimensions).fill(0.2)), usage: { tokens: values.length * 8 }, warnings: [] };
  });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await runSchemaTransition(engine, dimensions);
  home = mkdtempSync(join(tmpdir(), 'migration-facts-drain-'));
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_model: model,
    embedding_dimensions: dimensions, openai_api_key: 'synthetic-only' }));
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('embedding_model', model);
  await engine.setConfig('embedding_dimensions', String(dimensions));
  resetGateway();
  configureGateway({ embedding_model: model, embedding_dimensions: dimensions, env: { OPENAI_API_KEY: 'synthetic-only' } });
  calls = [];
  transport();
});

afterEach(() => { __setEmbedTransportForTests(null); resetGateway(); });
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

async function flow() {
  return withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined }, async () => {
    const options = { to: model, dim: dimensions, reranker: 'off', maxCostUsd: 1, quiet: true };
    return executeMigrationFlow(engine, await planMigrationFlow(engine, options), options);
  });
}

async function seed(sourceId: string, count: number) {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
  await engine.executeRaw(`INSERT INTO facts(fact,source,source_id)
    SELECT $1 || ' claim ' || n, 'synthetic', $1 FROM generate_series(1,$2::int) n`, [sourceId, count]);
}

async function pending(sourceId: string) {
  const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND embedding IS NULL', [sourceId]);
  return Number(row.n);
}

test('migration fact drain does not inherit the standalone timer and reaches the next source', async () => {
  await seed('a-slow', 2);
  await seed('z-neighbor', 1);
  transport(async values => { if (values.some(v => v.startsWith('a-slow'))) await Bun.sleep(10); });
  // Compress only the standalone 60s timer; migration heartbeat deadlines remain real.
  const original = AbortSignal.timeout.bind(AbortSignal);
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(ms => original(ms === 60_000 ? 1 : ms));
  try {
    const result = await flow();
    expect(result.status).toBe('completed');
    expect(result).toMatchObject({ facts_embedded: 3, facts_remaining: 0 });
    expect(await pending('a-slow')).toBe(0);
    expect(await pending('z-neighbor')).toBe(0);
    expect(calls.flat().filter(v => v.includes(' claim '))).toHaveLength(3);
    expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeFalsy();
    expect(await engine.getConfig(MIGRATION_COMPLETED_KEY)).toBeTruthy();
  } finally { timeout.mockRestore(); }
});

test('migration fact drain covers more than 10000 facts without replay and completes later sources', async () => {
  await seed('a-large', 10_001);
  await seed('z-neighbor', 1);
  const result = await flow();
  expect(result.status).toBe('completed');
  expect(result).toMatchObject({ facts_embedded: 10_002, facts_remaining: 0 });
  const texts = calls.flat().filter(v => v.includes(' claim '));
  expect(texts).toHaveLength(10_002);
  expect(new Set(texts).size).toBe(10_002);
  expect(await pending('a-large')).toBe(0);
  expect(await pending('z-neighbor')).toBe(0);
  const receipt = JSON.parse((await engine.getConfig(MIGRATION_COMPLETED_KEY))!);
  expect(receipt.budget.requests).toBeGreaterThan(100);
}, 120_000);

test('standalone fact repair retains its explicit row and runtime bounds', async () => {
  await seed('default', 3);
  const bounded = await embedStaleFacts(engine, { sourceId: 'default', yes: true, maxCostUsd: 1, maxFacts: 1 });
  expect(bounded).toMatchObject({ embedded: 1, remaining: 2, stopped: 'limit' });
  transport(async () => { await Bun.sleep(10); });
  const timed = await embedStaleFacts(engine, { sourceId: 'default', yes: true, maxCostUsd: 1, budgetMs: 1 });
  expect(timed).toMatchObject({ embedded: 0, remaining: 2, failures: 0, stopped: 'time_budget' });
  expect(await pending('default')).toBe(2);
});

test('#6588 a standalone wall-clock stop is a time_budget stop, not a failure', async () => {
  await seed('default', 6);
  transport(async () => { await Bun.sleep(150); });
  const r = await embedStaleFacts(engine, { sourceId: 'default', yes: true, maxCostUsd: 1, batchSize: 1, budgetMs: 400 });
  expect(r.embedded).toBeGreaterThan(0);
  expect(r.remaining).toBe(6 - r.embedded);
  expect(r).toMatchObject({ failures: 0, failure_samples: [], stopped: 'time_budget' });
});

test('#6588 an external abort stays a failure', async () => {
  await seed('default', 2);
  const controller = new AbortController();
  transport(async () => { controller.abort(); });
  const r = await embedStaleFacts(engine, { sourceId: 'default', yes: true, maxCostUsd: 1, batchSize: 1, signal: controller.signal });
  expect(r.stopped).toBe('aborted');
  expect(r.failures).toBeGreaterThan(0);
  expect(await pending('default')).toBe(2);
});

test('provider failure retains committed batches and migration authorization for resume', async () => {
  await seed('a-partial', 101);
  await seed('z-neighbor', 1);
  transport(async values => { if (values.includes('a-partial claim 101')) throw new Error('synthetic provider failure'); });
  const first = await flow();
  expect(first.status).toBe('incomplete');
  expect(first).toMatchObject({ facts_embedded: 100, facts_remaining: 2 });
  expect(await pending('a-partial')).toBe(1);
  expect(await pending('z-neighbor')).toBe(1);
  const prior = JSON.parse((await engine.getConfig(MIGRATION_STATE_KEY))!).budget;
  expect(prior.requests).toBeGreaterThan(0);
  calls = [];
  transport();
  const resumed = await flow();
  expect(resumed.status).toBe('completed');
  expect(resumed).toMatchObject({ facts_embedded: 2, facts_remaining: 0 });
  expect(calls.flat().filter(v => v.includes(' claim '))).toEqual(['a-partial claim 101', 'z-neighbor claim 1']);
  const receipt = JSON.parse((await engine.getConfig(MIGRATION_COMPLETED_KEY))!);
  expect(receipt.budget.requests).toBeGreaterThan(prior.requests);
  expect(receipt.budget.debited_usd).toBeGreaterThanOrEqual(prior.debited_usd);
});

test('lease loss during a later fact batch refuses its vectors and preserves earlier progress', async () => {
  await seed('a-partial', 101);
  await seed('z-neighbor', 1);
  transport(async values => {
    if (values.includes('a-partial claim 101')) {
      await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [GLOBAL_MIGRATION_LOCK_ID]);
    }
  });
  const result = await flow();
  expect(result.status).toBe('apply_failed');
  expect(JSON.stringify(result)).toContain('lease lost');
  expect(await pending('a-partial')).toBe(1);
  expect(await pending('z-neighbor')).toBe(1);
  expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeTruthy();
  expect(await engine.getConfig(MIGRATION_COMPLETED_KEY)).toBeFalsy();
});

test('new fact arrivals do not extend the initial drain census or falsely complete migration', async () => {
  await seed('default', 1);
  let inserted = false;
  transport(async values => {
    if (!inserted && values.includes('default claim 1')) {
      inserted = true;
      await engine.insertFact({ fact: 'Synthetic late arrival', source: 'synthetic' }, { source_id: 'default' });
    }
  });
  const result = await flow();
  expect(result).toMatchObject({ status: 'incomplete', facts_embedded: 1, facts_remaining: 1 });
  expect(calls.flat()).not.toContain('Synthetic late arrival');
  expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeTruthy();
  expect(await engine.getConfig(MIGRATION_COMPLETED_KEY)).toBeFalsy();
});
