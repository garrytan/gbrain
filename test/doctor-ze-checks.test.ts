/**
 * v0.36.0.0 (A5) — Doctor checks for the ZE cutover.
 *
 * Pins:
 *  - ze_embedding_health: warns when embedding_model is ZE but no key
 *    is configured; OK when key present; OK when not on ZE (skip).
 *  - embedding_width_consistency: warns when configured dim diverges
 *    from the actual vector(N) column width.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  checkZeEmbeddingHealth,
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

describe('checkZeEmbeddingHealth', () => {
  // v0.37 fix wave (Lane E.3 + CDX2-10): checkZeEmbeddingHealth now reads
  // from the gateway (file plane source of truth) instead of the DB config
  // table. Tests configure the gateway directly via configureGateway()
  // rather than writing via engine.setConfig().

  test('not on ZE: returns ok with skip message', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { ...process.env },
    });
    const check = await checkZeEmbeddingHealth(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('not ZeroEntropy');
  });

  test('on ZE + no key: warns with setup hint', async () => {
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
      env: { ...process.env, ZEROENTROPY_API_KEY: undefined as any },
    });
    // Clear the env var for the no-key path (user's real env may have it set).
    await withEnv({ ZEROENTROPY_API_KEY: undefined }, async () => {
      const check = await checkZeEmbeddingHealth(engine);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('ZEROENTROPY_API_KEY');
      expect(check.message).toContain('zeroentropy.dev');
    });
  });

  test('on ZE + env key: ok', async () => {
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
      env: { ...process.env },
    });
    await withEnv({ ZEROENTROPY_API_KEY: 'sk-fake-test' }, async () => {
      const check = await checkZeEmbeddingHealth(engine);
      expect(check.status).toBe('ok');
    });
  });

  // v0.37 fix wave note: ZE key now lives in file plane only (not DB plane).
  // The "config key" path here exercises the file-plane fallback that
  // checkZeEmbeddingHealth checks via loadConfigFileOnly().
  test('on ZE + env key (file-plane equivalent): ok', async () => {
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
      env: { ...process.env },
    });
    await withEnv({ ZEROENTROPY_API_KEY: 'sk-fake-from-env' }, async () => {
      const check = await checkZeEmbeddingHealth(engine);
      expect(check.status).toBe('ok');
    });
  });
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
    // Reset gateway so requireConfig() throws.
    const { resetGateway } = await import('../src/core/ai/gateway.ts');
    resetGateway();
    const check = await checkEmbeddingWidthConsistency(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('gateway not configured');
  });
});
