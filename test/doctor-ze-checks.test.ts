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
  test('not on ZE: returns ok with skip message', async () => {
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
    const check = await checkZeEmbeddingHealth(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('not ZeroEntropy');
  });

  test('on ZE + no key: warns with setup hint', async () => {
    await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
    // Clear the env var for the no-key path (user's real env may have it set).
    await withEnv({ ZEROENTROPY_API_KEY: undefined }, async () => {
      const check = await checkZeEmbeddingHealth(engine);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('ZEROENTROPY_API_KEY');
      expect(check.message).toContain('zeroentropy.dev');
    });
  });

  test('on ZE + env key: ok', async () => {
    await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
    await withEnv({ ZEROENTROPY_API_KEY: 'sk-fake-test' }, async () => {
      const check = await checkZeEmbeddingHealth(engine);
      expect(check.status).toBe('ok');
    });
  });

  test('on ZE + config key (not env): ok', async () => {
    await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
    await engine.setConfig('zeroentropy_api_key', 'sk-fake-config');
    const check = await checkZeEmbeddingHealth(engine);
    expect(check.status).toBe('ok');
  });
});

describe('checkEmbeddingWidthConsistency', () => {
  test('config matches schema width: ok', async () => {
    // Fresh schema is sized to DEFAULT_EMBEDDING_DIMENSIONS via initSchema.
    // We just need config to declare the same number. The actual default is
    // 1280 after the v0.36.0.0 flip but PGLite initSchema reads what the
    // gateway was last configured for; bypass by reading the actual column.
    // The check itself is what we're testing.
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

    await engine.setConfig('embedding_dimensions', String(schemaDim));
    const check = await checkEmbeddingWidthConsistency(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain(`${schemaDim}d`);
  });

  test('config mismatches schema width: warns with fix hint', async () => {
    // Pick an obviously-different number. The schema is whatever initSchema
    // produced; we just need config to say something else.
    await engine.setConfig('embedding_dimensions', '99999');
    const check = await checkEmbeddingWidthConsistency(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('mismatch');
    expect(check.message).toContain('ze-switch --resume');
  });

  test('missing config: ok with hint about defaults', async () => {
    // No embedding_dimensions key set.
    const check = await checkEmbeddingWidthConsistency(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('defaults');
  });

  test('invalid config value: warns', async () => {
    await engine.setConfig('embedding_dimensions', 'not-a-number');
    const check = await checkEmbeddingWidthConsistency(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('not a positive integer');
  });
});
