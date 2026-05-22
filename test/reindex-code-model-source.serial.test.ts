/**
 * v0.37.3 — MANDATORY REGRESSION (IRON RULE).
 *
 * SERIAL: gateway is process-global; configureGateway() in this file
 * would race with other parallel-loop tests that read getEmbeddingModelName().
 *
 * Pre-v0.37.3, runReindexCode returned `model: EMBEDDING_MODEL` where
 * `EMBEDDING_MODEL` was a back-compat shim hardcoded to
 * 'text-embedding-3-large'. The cost-preview message printed that
 * stale name even when the user had configured `voyage:voyage-code-3`,
 * producing a directly-contradictory line right next to the new code-
 * model nudge.
 *
 * v0.37.3 routes the model field through `getEmbeddingModelName()` so
 * the preview reflects what the gateway will actually use. This test
 * pins that contract: the model field MUST equal the gateway-configured
 * embedding model name, not the legacy hardcoded constant.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReindexCode } from '../src/commands/reindex-code.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

describe('runReindexCode — model field reflects gateway (IRON RULE regression)', () => {
  let engine: PGLiteEngine;
  let prevNudgeEnv: string | undefined;

  beforeAll(async () => {
    // Suppress nudge so it doesn't write to stderr during this test.
    prevNudgeEnv = process.env.GBRAIN_NO_CODE_MODEL_NUDGE;
    process.env.GBRAIN_NO_CODE_MODEL_NUDGE = '1';

    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    await engine.putPage('src-foo-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'src/foo.ts (typescript)',
      compiled_truth: 'export function foo() { return 42; }',
      timeline: '',
      frontmatter: { language: 'typescript', file: 'src/foo.ts' },
    });
  });

  afterAll(async () => {
    await engine.disconnect();
    resetGateway();
    if (prevNudgeEnv === undefined) delete process.env.GBRAIN_NO_CODE_MODEL_NUDGE;
    else process.env.GBRAIN_NO_CODE_MODEL_NUDGE = prevNudgeEnv;
  }, 30_000);

  test('voyage:voyage-code-3 configured → result.model is "voyage-code-3", NOT "text-embedding-3-large"', async () => {
    configureGateway({
      embedding_model: 'voyage:voyage-code-3',
      embedding_dimensions: 1024,
      env: { VOYAGE_API_KEY: 'pa-test' },
    });
    const result = await runReindexCode(engine, { dryRun: true });
    expect(result.model).toBe('voyage-code-3');
    expect(result.model).not.toBe('text-embedding-3-large');
    resetGateway();
  });

  test('openai:text-embedding-3-small configured → result.model is "text-embedding-3-small"', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    const result = await runReindexCode(engine, { dryRun: true });
    expect(result.model).toBe('text-embedding-3-small');
    resetGateway();
  });

  test('voyage:voyage-4-large configured → result.model is "voyage-4-large"', async () => {
    // Regression coverage: any provider:model the gateway accepts should
    // round-trip through the cost preview as the bare name.
    configureGateway({
      embedding_model: 'voyage:voyage-4-large',
      embedding_dimensions: 2048,
      env: { VOYAGE_API_KEY: 'pa-test' },
    });
    const result = await runReindexCode(engine, { dryRun: true });
    expect(result.model).toBe('voyage-4-large');
    resetGateway();
  });
});
