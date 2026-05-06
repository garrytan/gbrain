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
  test('returns null when base config is null', async () => {
    const result = await loadConfigWithEngine(makeEngine({}), null);
    expect(result).toBeNull();
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
});
