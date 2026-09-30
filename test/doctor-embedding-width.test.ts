import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  checkEmbeddingWidthConsistency,
} from '../src/commands/doctor.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // Env is owned per-test by withEnv; nothing to clean up here.
});

describe('checkEmbeddingWidthConsistency', () => {
  // v0.37 fix wave (Lane E.1 + CDX-8): check reads from gateway, NOT DB
  // config. Tests configure the gateway directly so we can simulate the
  // mismatch scenario.

  test('config matches schema width: ok', async () => {
    // Read the actual schema column dim, then configure the gateway to
    // match. The check should report ok.
    const rows = await engine.executeRaw<{ format_type: string }>(
      `SELECT format_type(atttypid, atttypmod) AS format_type
         FROM pg_attribute
        WHERE attrelid = 'content_chunks'::regclass
          AND attname = 'embedding'
          AND NOT attisdropped`,
    );
    const m = rows[0].format_type.match(/vector\((\d+)\)/i);
    expect(m).not.toBeNull();
    const schemaDim = parseInt(m![1], 10);

    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: schemaDim,
      env: { ...process.env },
    });
    const check = await checkEmbeddingWidthConsistency(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain(`${schemaDim}d`);
  });

  test('config mismatches schema width: warns with fix hint', async () => {
    // Configure gateway to a dim that doesn't match the schema. With the
    // preload setting OpenAI/1536 and re-applying per-test, the schema
    // is 1536 — so 768 is guaranteed-different here.
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 768,
      env: { ...process.env },
    });
    const check = await checkEmbeddingWidthConsistency(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('mismatch');
    // v0.37 hint points at gbrain init (the path that works), not config set.
    expect(check.message).toContain('gbrain init');
  });

  test('gateway unconfigured: skips with ok', async () => {
    // Hard-unconfigure so requireConfig() throws — resetGateway() would
    // restore the preload's test baseline (#3554).
    const { __unconfigureGatewayForTests } = await import('../src/core/ai/gateway.ts');
    __unconfigureGatewayForTests();
    const check = await checkEmbeddingWidthConsistency(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('gateway not configured');
  });
});
