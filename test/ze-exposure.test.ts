/**
 * v0.46.3 — detectZeExposure truth table + engine-parity smoke.
 *
 * Exposure is EFFECTIVE-MODEL RESOLUTION (env → file → legacy fallback), not
 * vector evidence: a configless brain is deterministically ZE-exposed; 1280d
 * vectors alone prove nothing (OpenAI text-3 supports 1280). Probe failures
 * downgrade to 'unknown', never to 'clear'. The truth table runs against stub
 * engines (fast, no DB); the parity smoke runs the real SQL against a fresh
 * PGLite brain so the pages.embedding_signature / content_chunks probes are
 * pinned to a real schema.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { detectZeExposure, renderZeActionRequired } from '../src/core/ze-exposure.ts';

/** Stub engine: healthy brain with no rows. getConfig(null) → search-mode
 *  resolution falls through to the balanced bundle (reranker enabled on the
 *  legacy ZE default — deliberate: that IS the implicit-bundle exposure). */
function stubEngine(overrides?: Partial<Pick<BrainEngine, 'getConfig' | 'executeRaw'>>): BrainEngine {
  return {
    getConfig: overrides?.getConfig ?? (async () => null),
    executeRaw: overrides?.executeRaw ?? (async () => [{ n: 0 }] as any),
  } as unknown as BrainEngine;
}

/** A brain whose reranker is already off ZE (explicit voyage override). */
function voyageRerankerEngine(): BrainEngine {
  return stubEngine({
    getConfig: async (key: string) =>
      key === 'search.reranker.model' ? 'voyage:rerank-2.5' : null,
  });
}

const CLEAN_ENV = {} as NodeJS.ProcessEnv;

describe('detectZeExposure — embedding axis (resolution, not evidence)', () => {
  test('configless brain (no file config at all) → bareDefaultZe, exposed', async () => {
    const e = await detectZeExposure(voyageRerankerEngine(), null, CLEAN_ENV);
    expect(e.zeEmbedding).toBe(true);
    expect(e.bareDefaultZe).toBe(true);
    expect(e.zeExplicit).toBe(false);
    expect(e.status).toBe('exposed');
  });

  test('file config with no embedding_model → bareDefaultZe, exposed', async () => {
    const cfg = { engine: 'pglite' } as GBrainConfig;
    const e = await detectZeExposure(voyageRerankerEngine(), cfg, CLEAN_ENV);
    expect(e.bareDefaultZe).toBe(true);
    expect(e.status).toBe('exposed');
  });

  test('explicit ZE file config → zeExplicit, exposed', async () => {
    const cfg = { embedding_model: 'zeroentropyai:zembed-1' } as GBrainConfig;
    const e = await detectZeExposure(voyageRerankerEngine(), cfg, CLEAN_ENV);
    expect(e.zeExplicit).toBe(true);
    expect(e.bareDefaultZe).toBe(false);
    expect(e.status).toBe('exposed');
  });

  test('voyage-configured brain with voyage reranker → clear', async () => {
    const cfg = {
      embedding_model: 'voyage:voyage-4',
      embedding_dimensions: 1024,
    } as GBrainConfig;
    const e = await detectZeExposure(voyageRerankerEngine(), cfg, CLEAN_ENV);
    expect(e.zeEmbedding).toBe(false);
    expect(e.zeReranker).toBe(false);
    expect(e.status).toBe('clear');
  });

  test('embedding_disabled (keyless) suppresses the embedding axis', async () => {
    const cfg = { embedding_disabled: true } as GBrainConfig;
    const e = await detectZeExposure(voyageRerankerEngine(), cfg, CLEAN_ENV);
    expect(e.zeEmbedding).toBe(false);
    expect(e.bareDefaultZe).toBe(false);
  });

  test('env override naming ZE wins over a clean file config → envOverride, exposed', async () => {
    const cfg = { embedding_model: 'openai:text-embedding-3-small' } as GBrainConfig;
    const env = { GBRAIN_EMBEDDING_MODEL: 'zeroentropyai:zembed-1' } as NodeJS.ProcessEnv;
    const e = await detectZeExposure(voyageRerankerEngine(), cfg, env);
    expect(e.envOverride).toBe(true);
    expect(e.zeEmbedding).toBe(true);
    expect(e.zeExplicit).toBe(false);
    expect(e.status).toBe('exposed');
  });

  test('env override naming a SAFE provider clears a ZE file config', async () => {
    const cfg = { embedding_model: 'zeroentropyai:zembed-1' } as GBrainConfig;
    const env = { GBRAIN_EMBEDDING_MODEL: 'voyage:voyage-4' } as NodeJS.ProcessEnv;
    const e = await detectZeExposure(voyageRerankerEngine(), cfg, env);
    expect(e.zeEmbedding).toBe(false);
    expect(e.zeExplicit).toBe(false);
  });
});

describe('detectZeExposure — reranker + custom-column axes', () => {
  test('implicit bundle reranker (nothing configured) counts as exposure', async () => {
    // The bundle default stays legacy zerank-2 until September — a brain that
    // reranks with it today loses reranking on the sunset date.
    const cfg = { embedding_model: 'voyage:voyage-4' } as GBrainConfig;
    const e = await detectZeExposure(stubEngine(), cfg, CLEAN_ENV);
    expect(e.zeReranker).toBe(true);
    expect(e.status).toBe('exposed');
  });

  test('ZE-backed custom column is flagged by name', async () => {
    const cfg = {
      embedding_model: 'voyage:voyage-4',
      embedding_columns: {
        embedding_ze_bench: { provider: 'zeroentropyai:zembed-1', dimensions: 1280, type: 'vector' },
        embedding_openai: { provider: 'openai:text-embedding-3-small', dimensions: 1536, type: 'vector' },
      },
    } as unknown as GBrainConfig;
    const e = await detectZeExposure(voyageRerankerEngine(), cfg, CLEAN_ENV);
    expect(e.zeCustomColumns).toEqual(['embedding_ze_bench']);
    expect(e.status).toBe('exposed');
  });

  test('hasVoyageKey reads BOTH env and file plane', async () => {
    const cfg = { voyage_api_key: 'pa-file' } as GBrainConfig;
    const viaFile = await detectZeExposure(voyageRerankerEngine(), cfg, CLEAN_ENV);
    expect(viaFile.hasVoyageKey).toBe(true);
    const viaEnv = await detectZeExposure(voyageRerankerEngine(), null, {
      VOYAGE_API_KEY: 'pa-env',
    } as NodeJS.ProcessEnv);
    expect(viaEnv.hasVoyageKey).toBe(true);
  });
});

describe('detectZeExposure — tri-state (unknown never silently clears)', () => {
  test('probe failure on an otherwise-clear brain → unknown, not clear', async () => {
    // Search-mode resolution fails OPEN internally (a broken config read
    // falls through to the bundle → ZE → exposed, which is itself fail-safe).
    // The truly-unknown shape: reranker override readable and safe, but the
    // custom-column registry probe fails.
    const partiallyBroken = stubEngine({
      getConfig: async (key: string) => {
        if (key === 'search.reranker.model') return 'voyage:rerank-2.5';
        if (key === 'embedding_columns') throw new Error('relation "config" corrupt');
        return null;
      },
    });
    const cfg = { embedding_model: 'voyage:voyage-4' } as GBrainConfig;
    const e = await detectZeExposure(partiallyBroken, cfg, CLEAN_ENV);
    expect(e.status).toBe('unknown');
    expect(e.unknownProbes).toContain('embedding_columns_db');
  });

  test('fully-broken engine on a clear-config brain fails SAFE (exposed via bundle), never clear', async () => {
    const broken = stubEngine({
      getConfig: async () => {
        throw new Error('boom');
      },
      executeRaw: async () => {
        throw new Error('boom');
      },
    });
    const cfg = { embedding_model: 'voyage:voyage-4' } as GBrainConfig;
    const e = await detectZeExposure(broken, cfg, CLEAN_ENV);
    // Mode resolution falls open to the balanced bundle (legacy ZE reranker)
    // → exposed. The invariant under ANY probe failure: status !== 'clear'.
    expect(e.status).not.toBe('clear');
  });

  test('probe failure on an exposed brain stays exposed (exposure is config-derived)', async () => {
    const broken = stubEngine({
      getConfig: async () => {
        throw new Error('boom');
      },
      executeRaw: async () => {
        throw new Error('boom');
      },
    });
    const e = await detectZeExposure(broken, null, CLEAN_ENV);
    expect(e.status).toBe('exposed'); // configless → ZE fallback, deterministic
  });
});

describe('detectZeExposure — blast radius (capped, informational)', () => {
  test('caps counts at 100k and marks them capped', async () => {
    const big = stubEngine({
      getConfig: async (key: string) =>
        key === 'search.reranker.model' ? 'voyage:rerank-2.5' : null,
      executeRaw: async () => [{ n: 100_001 }] as any,
    });
    const e = await detectZeExposure(big, null, CLEAN_ENV);
    expect(e.blastRadius.embeddedChunks).toBe(100_000);
    expect(e.blastRadius.embeddedChunksCapped).toBe(true);
    expect(renderZeActionRequired(e)).toContain('100,000+');
  });

  test('cost estimate uses the recommended target price', async () => {
    const some = stubEngine({
      getConfig: async (key: string) =>
        key === 'search.reranker.model' ? 'voyage:rerank-2.5' : null,
      executeRaw: async () => [{ n: 1000 }] as any,
    });
    const e = await detectZeExposure(some, null, CLEAN_ENV);
    // 1000 chunks × ~400 tokens × $0.06/M (voyage-4) = $0.024
    expect(e.blastRadius.estReembedUsd).toBeCloseTo(0.024, 3);
  });
});

describe('renderZeActionRequired — notice copy', () => {
  test('names the axis, the date, and the paste-ready commands', async () => {
    const e = await detectZeExposure(stubEngine(), null, CLEAN_ENV);
    const text = renderZeActionRequired(e);
    expect(text).toContain('2026-09-04');
    expect(text).toContain('migrate embeddings --to voyage:voyage-4 --dim 1024');
    // Width-honest copy: the OpenAI alternative names the width slot generically
    // (the doctor prints the brain's exact width-aware command) — a static 1280
    // here would be wrong for 640d/2560d ZE brains.
    expect(text).toContain('openai:text-embedding-3-small --dim <width>');
    expect(text).toContain('gbrain doctor');
    expect(text).toContain('search.reranker.model voyage:rerank-2.5');
    expect(text).toContain('skills/migrations/v0.46.3.0.md');
    expect(text).toContain('Nothing has been changed automatically');
  });

  test('env-override notice says the env var itself must change', async () => {
    const e = await detectZeExposure(voyageRerankerEngine(), null, {
      GBRAIN_EMBEDDING_MODEL: 'zeroentropyai:zembed-1',
    } as NodeJS.ProcessEnv);
    expect(renderZeActionRequired(e)).toContain('GBRAIN_EMBEDDING_MODEL');
  });
});

describe('detectZeExposure — PGLite engine parity smoke', () => {
  test('the blast-radius SQL runs against a real fresh brain (no unknown probes)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ze-exposure-'));
    const { createEngine } = await import('../src/core/engine-factory.ts');
    const engine = await createEngine({ engine: 'pglite' });
    await engine.connect({ engine: 'pglite', database_path: join(dir, 'brain') });
    try {
      await engine.initSchema();
      const e = await detectZeExposure(engine, null, CLEAN_ENV);
      // Configless → exposed via the legacy fallback; every probe must have
      // RUN cleanly on the real schema (pages.embedding_signature exists,
      // content_chunks counts work).
      expect(e.status).toBe('exposed');
      expect(e.unknownProbes).toEqual([]);
      expect(e.blastRadius.zeSignedPages).toBe(0);
      expect(e.blastRadius.embeddedChunks).toBe(0);
    } finally {
      await engine.disconnect();
    }
  }, 120_000);
});
