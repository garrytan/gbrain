/**
 * #6587: lease loss and census failures say what happened. A preflight probe
 * the invocation guard refused because the lease was lost names the lease
 * (status stays probe_failed); a census database error names its SQLSTATE but
 * never the error text (a data error can quote stored content); a deadlock
 * victim stays recognizable so withMigrationLeaseTransaction can rerun it.
 */
import { afterAll, beforeAll, afterEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { probeTargetProvider } from '../src/commands/migrate-embeddings.ts';
import { assertRetainedEmbeddingRebuildability } from '../src/core/embedding-migration-retention.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'synthetic-only' } });
}, 120_000);
afterAll(async () => { resetGateway(); await engine.disconnect(); });
afterEach(() => { __setEmbedTransportForTests(null); });

test('a probe refused for a lost lease names the lease, not the provider', async () => {
  __setEmbedTransportForTests(async () => { throw new Error('Migration lock lease lost; further mutations refused.'); });
  const lost = await probeTargetProvider('openai:text-embedding-3-small', 1536);
  expect(lost.ok).toBe(false);
  expect(!lost.ok && lost.message).toContain('lost its lock lease');
  __setEmbedTransportForTests(async () => { throw new Error('SYNTHETIC_PRIVATE_PROVIDER_BODY'); });
  const outage = await probeTargetProvider('openai:text-embedding-3-small', 1536);
  expect(!outage.ok && outage.message).toContain('Check provider configuration');
  expect(!outage.ok && outage.message).not.toContain('SYNTHETIC_PRIVATE_PROVIDER_BODY');
});

const failingCensus = (base: BrainEngine, error: Error) => new Proxy(base, { get(target, key) {
  if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
    if (sql.includes('AS pages')) throw error;
    return target.executeRaw(sql, params as never);
  };
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
} }) as unknown as BrainEngine;

test('a census database error names its SQLSTATE and keeps stored text out; a deadlock is rethrown as-is', async () => {
  const data = Object.assign(new Error('invalid input syntax for type integer: "SYNTHETIC_STORED_TEXT"'), { code: '22P02' });
  const error = await engine.transaction(tx => assertRetainedEmbeddingRebuildability(failingCensus(tx, data), 1536, 'openai:text-embedding-3-small').then(() => null)).catch((e: unknown) => e as Error);
  if (!error) throw new Error('the census error did not propagate');
  expect(error.message).toContain('retained_vector_check_failed');
  expect(error.message).toContain('SQLSTATE 22P02');
  expect(error.message).not.toContain('SYNTHETIC_STORED_TEXT');
  const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
  await expect(engine.transaction(tx => assertRetainedEmbeddingRebuildability(failingCensus(tx, deadlock), 1536, 'openai:text-embedding-3-small'))).rejects.toBe(deadlock);
});
