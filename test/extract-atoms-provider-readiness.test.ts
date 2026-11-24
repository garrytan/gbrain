import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';

describe('extract_atoms provider readiness', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('models.dream.extract_atoms', 'deepseek:deepseek-flash');
    await engine.putPage('article/provider-readiness', {
      type: 'article',
      title: 'Example only',
      compiled_truth: 'An invented sample about a fictional project. '.repeat(20),
    }, { sourceId: 'default' });
  });
  afterAll(async () => {
    await engine.disconnect();
    resetGateway();
  });

  test('a worker without credentials is blocked by configuration, not a failed provider call', async () => {
    const phase = await runPhaseExtractAtoms(engine, { sourceId: 'default', _transcripts: [] });
    expect(phase.details.aborted_global_error).toBeUndefined();
    expect(phase.details.reason).toBe('provider_not_configured');
  });
});
