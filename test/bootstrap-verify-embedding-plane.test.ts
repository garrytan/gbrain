/**
 * #4287 — `bootstrap verify` must probe the ACTIVE embedding plane
 * end-to-end. Pre-fix, verify's roundtrip passed keyless-style (put_page
 * skips embedding when the gateway is unavailable in verify's process) on a
 * brain whose configured embedder and schema column disagreed — certifying
 * PASS, including `roundtrip`, while every keyed write failed with
 * "expected N dimensions, not M".
 *
 * checkEmbeddingPlane pins:
 *   - keyless → ok (no active plane exists; writes store no vectors by design)
 *   - keyed + emitted width == column width → ok, "verified end-to-end"
 *   - keyed + emitted width != column width → named FAIL carrying both
 *     widths + the recovery command (the RETURNED width is the truth — the
 *     observed split emitted a width no config plane named)
 *   - keyed + dead probe → warn (roundtrip owns hard put failures)
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkEmbeddingPlane } from '../src/core/bootstrap/verify.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';

const KEYLESS: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: false },
  search: 'keyword-only',
  mode: 'keyless',
};
const KEYED: CapabilityReport = {
  embeddings: { available: true, provider: 'openai' },
  extraction: { available: false },
  search: 'semantic',
  mode: 'keyed',
};

let engine: PGLiteEngine;
let colDim: number;

function installTransport(emitDim: number, fail = false): void {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: emitDim,
    env: { OPENAI_API_KEY: 'sk-test-fake' },
  });
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    if (fail) throw new Error('mock provider exploded');
    return {
      embeddings: values.map(() => new Array(emitDim).fill(0.01)),
      usage: { tokens: values.length * 4 },
    } as never;
  });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'
        AND attnum > 0 AND NOT attisdropped`,
  );
  colDim = Number(rows[0]?.dim);
  resetGateway();
}, 30000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

describe('checkEmbeddingPlane (#4287)', () => {
  test('keyless: ok — no active plane to probe', async () => {
    const check = await checkEmbeddingPlane(engine, KEYLESS);
    expect(check.id).toBe('embedding_plane');
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('keyless');
  });

  test('keyed + widths agree: ok, verified end-to-end', async () => {
    installTransport(colDim);
    const check = await checkEmbeddingPlane(engine, KEYED);
    expect(check.ok).toBe(true);
    expect(check.warn).toBeUndefined();
    expect(check.detail).toContain('verified end-to-end');
    expect(check.detail).toContain(`${colDim}d`);
  });

  test('keyed + plane split: named FAIL carrying both widths + the fix', async () => {
    const emit = colDim === 24 ? 32 : 24;
    installTransport(emit);
    const check = await checkEmbeddingPlane(engine, KEYED);
    expect(check.ok).toBe(false); // pre-fix: verify had no such check at all
    expect(check.detail).toContain('EMBEDDING PLANE SPLIT');
    expect(check.detail).toContain(`returns ${emit}d vectors`);
    expect(check.detail).toContain(`${colDim}d`);
    expect(check.detail).toContain(`expected ${colDim} dimensions, not ${emit}`);
    expect(check.detail).toContain('gbrain migrate embeddings');
  });

  test('keyed + dead probe: warn, never a false certification', async () => {
    installTransport(colDim, true);
    const check = await checkEmbeddingPlane(engine, KEYED);
    expect(check.ok).toBe(true);
    expect(check.warn).toBe(true);
    expect(check.detail).toContain('cannot verify the active embedding plane');
  });
});

// S2 (registry read/write unification): the probe must compare the embedder
// against the registry-ACTIVE column, not the literal legacy `embedding`.
// Pre-fix, a healthy brain routed to an 8d registry column false-FAILed
// because the probe width was compared to the legacy column's width.
describe('checkEmbeddingPlane on a registry-routed brain (S2)', () => {
  const REG_JSON = JSON.stringify({
    embedding_reg8: { provider: 'openai:text-embedding-3-small', dimensions: 8, type: 'vector' },
  });

  beforeAll(async () => {
    await engine.executeRaw(
      `ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_reg8 vector(8)`,
    );
    await engine.setConfig('search_embedding_column', 'embedding_reg8');
    await engine.setConfig('embedding_columns', REG_JSON);
  });

  afterAll(async () => {
    await engine.unsetConfig('search_embedding_column');
    await engine.unsetConfig('embedding_columns');
  });

  test('keyed + embedder agrees with the ACTIVE column: ok (pre-fix false FAIL)', async () => {
    installTransport(8);
    const check = await checkEmbeddingPlane(engine, KEYED);
    expect(check.ok).toBe(true);
    expect(check.warn).toBeUndefined();
    expect(check.detail).toContain('verified end-to-end');
    expect(check.detail).toContain('content_chunks.embedding_reg8');
    expect(check.detail).toContain('8d');
  });

  test('keyed + genuine mismatch against the ACTIVE column: named FAIL', async () => {
    installTransport(24);
    const check = await checkEmbeddingPlane(engine, KEYED);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('EMBEDDING PLANE SPLIT');
    expect(check.detail).toContain('content_chunks.embedding_reg8');
    expect(check.detail).toContain('returns 24d vectors');
    expect(check.detail).toContain('expected 8 dimensions, not 24');
  });

  test('unresolvable registry row: named FAIL carrying the resolver hint', async () => {
    await engine.setConfig('search_embedding_column', 'embedding_ghost');
    installTransport(8);
    const check = await checkEmbeddingPlane(engine, KEYED);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('embedding_ghost');
    expect(check.detail).toContain('cannot be resolved');
    await engine.setConfig('search_embedding_column', 'embedding_reg8');
  });

  test('keyless registry brain: ok, names the active column', async () => {
    const check = await checkEmbeddingPlane(engine, KEYLESS);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('keyless');
    expect(check.detail).toContain('content_chunks.embedding_reg8');
  });
});
