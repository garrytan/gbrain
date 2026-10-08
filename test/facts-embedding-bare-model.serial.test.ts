/**
 * #6113 (fix wave 12, W1.6, refusal half): a legacy brain whose DB
 * `embedding_model` row has no provider prefix stops managed fact extraction.
 * The refusal names the one supported rewrite, previewed read-only, with the
 * provider the gateway resolves for that model; it never reads the per-host
 * file plane as the brain's identity.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { resolveManagedFactsEmbedding } from '../src/core/persistence/facts-maintenance.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.setConfig('embedding_model', 'text-embedding-3-small');
  await engine.setConfig('embedding_dimensions', '1536');
}, 60_000);
afterAll(async () => { resetGateway(); await engine.disconnect(); });

test('a bare DB model refuses with the migrate preview for the gateway provider', async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-fake' } });
  const error = await resolveManagedFactsEmbedding(engine, { engine: 'pglite' } as GBrainConfig).then(() => null, e => e);
  expect(error).toMatchObject({ code: 'embedding_configuration' });
  expect(error.suggestion).toContain('"text-embedding-3-small" with no provider prefix');
  expect(error.suggestion).toContain('gbrain migrate embeddings --to openai:text-embedding-3-small --dry-run');
  expect(error.fix).toMatchObject({ argv: ['gbrain', 'migrate', 'embeddings', '--to', 'openai:text-embedding-3-small', '--dry-run'], actor: 'agent' });
});

test('a gateway on another model names no provider and falls back to the read-only readiness report', async () => {
  configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, env: { VOYAGE_API_KEY: 'test-fake' } });
  const error = await resolveManagedFactsEmbedding(engine, { engine: 'pglite' } as GBrainConfig).then(() => null, e => e);
  expect(error.suggestion).toContain('--to <provider>:text-embedding-3-small --dry-run');
  expect(error.fix.argv).toEqual(['gbrain', 'doctor', '--only', 'embeddings', '--json']);
});
