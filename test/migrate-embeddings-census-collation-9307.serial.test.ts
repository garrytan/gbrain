import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runSchemaTransition } from '../src/core/embedding-migration.ts';
import { executeMigrationFlow, planMigrationFlow } from '../src/commands/migrate-embeddings.ts';

const model = 'openai:text-embedding-3-small';
const dimensions = 8;
let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await runSchemaTransition(engine, dimensions);
  home = mkdtempSync(join(tmpdir(), 'migration-census-collation-'));
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
  __setEmbedTransportForTests(async ({ values }) => ({ values, embeddings: values.map(() => Array(dimensions).fill(0.2)), usage: { tokens: values.length * 8 }, warnings: [] }));
});
afterEach(() => { __setEmbedTransportForTests(null); resetGateway(); });
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

// Simulates a linguistic collation: the census query returns ids ignoring hyphens.
const linguistic = (base: BrainEngine): BrainEngine => new Proxy(base, { get(target, key) {
  if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
    const rows = await target.executeRaw<{ id: string }>(sql, params as never);
    if (!/FROM sources ORDER BY id$/.test(sql)) return rows;
    return [...rows].sort((a, b) => a.id.replace(/-/g, '') < b.id.replace(/-/g, '') ? -1 : 1);
  };
  if (key === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => fn(linguistic(tx)));
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
} }) as unknown as BrainEngine;

test('source census check does not depend on the database collation order', async () => {
  for (const id of ['auto-memory', 'automax-notes']) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [id]);
  }
  const outcome = await withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined }, async () => {
    const options = { to: model, dim: dimensions, reranker: 'off', maxCostUsd: 1, quiet: true };
    const wrapped = linguistic(engine);
    return executeMigrationFlow(wrapped, await planMigrationFlow(wrapped, options), options).catch((e: unknown) => ({ status: 'threw', reason: String(e) }));
  });
  expect(JSON.stringify(outcome)).not.toContain('Source census changed');
  expect(outcome.status).toBe('completed');
}, 60_000);
