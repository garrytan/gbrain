// Phase 4 (F3): loadConfigWithEngine() DB-merge contract.
//
// Verifies precedence (env > file > DB > defaults) for the new v0.27.1
// multimodal flags so `gbrain config set embedding_multimodal true`
// actually flips the runtime gate even when the file plane is silent.

import { describe, expect, test } from 'bun:test';
import { loadConfigWithEngine, type GBrainConfig } from '../src/core/config.ts';

interface FakeEngine {
  getConfig(key: string): Promise<string | null | undefined>;
}

function makeEngine(map: Record<string, string | null | undefined>): FakeEngine {
  return {
    async getConfig(key: string) {
      return map[key];
    },
  };
}

describe('loadConfigWithEngine (Phase 4 / F3)', () => {
  test('synthesizes a minimal base when base config is null (v0.36 codex /ship #3)', async () => {
    // Pre-v0.36 this returned null and skipped DB-plane merge entirely.
    // That meant env-only Postgres installs (no file config) couldn't see
    // DB-plane overrides set via `gbrain config set` — the documented
    // smoke test for `search_embedding_column` would silently fail.
    // The fix synthesizes a minimal `{ engine: 'postgres' }` base so DB
    // merge still runs; downstream callers either find the DB key or
    // fall through to defaults.
    const result = await loadConfigWithEngine(makeEngine({}), null);
    expect(result).not.toBeNull();
    expect(result?.engine).toBe('postgres');
  });

  test('DB-plane embedding_columns merge works even with null base (codex /ship #3 round-trip)', async () => {
    // The whole point of the synthesized fallback: env-only installs
    // calling `gbrain config set embedding_columns '...'` get those keys
    // back when the resolver re-reads config. Verifies the merge path
    // actually runs (not just that the function returns truthy).
    const engine = makeEngine({
      search_embedding_column: 'embedding_voyage',
      embedding_columns: '{"embedding_voyage":{"provider":"voyage:voyage-3-large","dimensions":1024,"type":"vector"}}',
    });
    const merged = await loadConfigWithEngine(engine, null);
    expect(merged?.search_embedding_column).toBe('embedding_voyage');
    expect(merged?.embedding_columns?.embedding_voyage?.dimensions).toBe(1024);
  });

  test('DB flag fills in when file/env did not set it', async () => {
    const base: GBrainConfig = { engine: 'pglite' };
    const engine = makeEngine({
      embedding_multimodal: 'true',
      embedding_image_ocr: 'false',
      embedding_image_ocr_model: 'openai:gpt-4o-mini',
    });
    const merged = await loadConfigWithEngine(engine, base);
    expect(merged?.embedding_multimodal).toBe(true);
    expect(merged?.embedding_image_ocr).toBe(false);
    expect(merged?.embedding_image_ocr_model).toBe('openai:gpt-4o-mini');
  });

  test('file/env precedence: file value wins over DB value', async () => {
    const base: GBrainConfig = {
      engine: 'pglite',
      embedding_multimodal: false,
      embedding_image_ocr_model: 'file-set-model',
    };
    const engine = makeEngine({
      embedding_multimodal: 'true',
      embedding_image_ocr_model: 'db-set-model',
    });
    const merged = await loadConfigWithEngine(engine, base);
    expect(merged?.embedding_multimodal).toBe(false);
    expect(merged?.embedding_image_ocr_model).toBe('file-set-model');
  });

  test('partial DB merge: only undefined fields fall through', async () => {
    const base: GBrainConfig = {
      engine: 'pglite',
      embedding_multimodal: true,
      // embedding_image_ocr NOT set in file plane
    };
    const engine = makeEngine({
      embedding_multimodal: 'false',
      embedding_image_ocr: 'true',
    });
    const merged = await loadConfigWithEngine(engine, base);
    // file/env wins for multimodal
    expect(merged?.embedding_multimodal).toBe(true);
    // DB fills in for ocr
    expect(merged?.embedding_image_ocr).toBe(true);
  });

  test('engine.getConfig throwing is non-fatal — file/env config still returned', async () => {
    const base: GBrainConfig = {
      engine: 'pglite',
      embedding_multimodal: true,
    };
    const engine: FakeEngine = {
      async getConfig() {
        throw new Error('config table missing');
      },
    };
    const merged = await loadConfigWithEngine(engine, base);
    expect(merged?.embedding_multimodal).toBe(true);
  });

  test('null/empty DB values are ignored (not coerced to false)', async () => {
    const base: GBrainConfig = { engine: 'pglite' };
    const engine = makeEngine({
      embedding_multimodal: null,
      embedding_image_ocr: '',
      embedding_image_ocr_model: undefined,
    });
    const merged = await loadConfigWithEngine(engine, base);
    expect(merged?.embedding_multimodal).toBeUndefined();
    expect(merged?.embedding_image_ocr).toBeUndefined();
    expect(merged?.embedding_image_ocr_model).toBeUndefined();
  });

  test('non-"true" DB string values resolve to false (strict equality)', async () => {
    const base: GBrainConfig = { engine: 'pglite' };
    const engine = makeEngine({
      embedding_multimodal: 'TRUE', // wrong case
      embedding_image_ocr: '1',     // wrong format
    });
    const merged = await loadConfigWithEngine(engine, base);
    expect(merged?.embedding_multimodal).toBe(false);
    expect(merged?.embedding_image_ocr).toBe(false);
  });

  // v0.28.11 (PR #719): embedding_multimodal_model precedence parity with the
  // sibling embedding_image_ocr_model field. Confirms the new key participates
  // in the same env > file > DB > undefined merge contract so that
  // embedMultimodal() routes correctly regardless of which plane set it.
  describe('embedding_multimodal_model precedence', () => {
    test('DB value fills in when file/env did not set it', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({
        embedding_multimodal_model: 'voyage:voyage-multimodal-3',
      });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.embedding_multimodal_model).toBe('voyage:voyage-multimodal-3');
    });

    test('file value wins over DB value', async () => {
      const base: GBrainConfig = {
        engine: 'pglite',
        embedding_multimodal_model: 'voyage:voyage-multimodal-3',
      };
      const engine = makeEngine({
        embedding_multimodal_model: 'voyage:voyage-3-large',
      });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.embedding_multimodal_model).toBe('voyage:voyage-multimodal-3');
    });

    test('all unset stays undefined', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({});
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.embedding_multimodal_model).toBeUndefined();
    });

    test('null/empty DB string is ignored (does not clobber)', async () => {
      const base: GBrainConfig = { engine: 'pglite' };
      const engine = makeEngine({
        embedding_multimodal_model: '',
      });
      const merged = await loadConfigWithEngine(engine, base);
      expect(merged?.embedding_multimodal_model).toBeUndefined();
    });
  });
});
