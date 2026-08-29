/**
 * #3973: per-run OCR ceiling in maybeOcr. An OCR-opted-in bulk import over a
 * large image corpus was an unbounded per-image LLM spend; the gate caps it
 * per process run via config embedding_image_ocr_max_images / _max_usd
 * (finite defaults), skips OCR over-cap, and bumps the persistent
 * `ocr_skipped_budget` counter that doctor's ocr_health check surfaces.
 *
 * Tests drive the gated body directly (_maybeOcrGatedForTests) so no env
 * mutation is needed, and preset the run state so the over-cap paths never
 * reach the gateway (deterministic offline). The under-cap path stubs the
 * generateText transport so a key-carrying dev environment can't make a
 * real call.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  _maybeOcrGatedForTests,
  _resetOcrRunBudgetForTests,
  _getOcrRunBudgetForTests,
} from '../src/core/import-file.ts';
import { __setGenerateTextTransportForTests } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const buf = Buffer.from('fake-image-bytes');

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  _resetOcrRunBudgetForTests();
  __setGenerateTextTransportForTests(null);
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetOcrRunBudgetForTests();
});

describe('per-run OCR budget gate (#3973)', () => {
  test('over the default image cap: skips OCR, bumps ocr_skipped_budget, never counts an attempt', async () => {
    _resetOcrRunBudgetForTests({ images: 200 }); // default cap is 200
    const out = await _maybeOcrGatedForTests(engine, buf, 'image/png');
    expect(out).toBe('');
    expect(await engine.getConfig('ocr_skipped_budget')).toBe('1');
    expect(await engine.getConfig('ocr_attempted')).toBeFalsy();
    // Skips don't consume budget.
    expect(_getOcrRunBudgetForTests().images).toBe(200);
    // Warned exactly once per run; a second skip stays quiet but still counts.
    expect(_getOcrRunBudgetForTests().warned).toBe(true);
    await _maybeOcrGatedForTests(engine, buf, 'image/png');
    expect(await engine.getConfig('ocr_skipped_budget')).toBe('2');
  });

  test('over the default estimated-USD cap trips independently of the image cap', async () => {
    _resetOcrRunBudgetForTests({ images: 1, estUsd: 1.0 }); // default USD cap is 1.0
    const out = await _maybeOcrGatedForTests(engine, buf, 'image/png');
    expect(out).toBe('');
    expect(await engine.getConfig('ocr_skipped_budget')).toBe('1');
    expect(await engine.getConfig('ocr_attempted')).toBeFalsy();
  });

  test('config lowers the image cap below the default', async () => {
    await engine.setConfig('embedding_image_ocr_max_images', '5');
    _resetOcrRunBudgetForTests({ images: 5 });
    const out = await _maybeOcrGatedForTests(engine, buf, 'image/png');
    expect(out).toBe('');
    expect(await engine.getConfig('ocr_skipped_budget')).toBe('1');
  });

  test('config lowers the USD cap below the default', async () => {
    await engine.setConfig('embedding_image_ocr_max_usd', '0.01');
    _resetOcrRunBudgetForTests({ images: 1, estUsd: 0.02 });
    const out = await _maybeOcrGatedForTests(engine, buf, 'image/png');
    expect(out).toBe('');
    expect(await engine.getConfig('ocr_skipped_budget')).toBe('1');
  });

  test('under the cap: the gate passes, consumes budget, and never bumps the skip counter', async () => {
    // Stub the final generateText call so a dev machine with a real API key
    // can't make a network call; keyless environments take the
    // ocr_failed_no_key branch. Either way the GATE behavior is identical.
    __setGenerateTextTransportForTests(async () => ({ text: 'stubbed ocr text', usage: {} }) as never);
    try {
      await _maybeOcrGatedForTests(engine, buf, 'image/png');
      const state = _getOcrRunBudgetForTests();
      expect(state.images).toBe(1);
      expect(state.estUsd).toBeGreaterThan(0);
      expect(await engine.getConfig('ocr_skipped_budget')).toBeFalsy();
      expect(await engine.getConfig('ocr_attempted')).toBe('1');
    } finally {
      __setGenerateTextTransportForTests(null);
    }
  });

  test('cap of 0 disables that ceiling (explicit unlimited opt-out)', async () => {
    await engine.setConfig('embedding_image_ocr_max_images', '0');
    await engine.setConfig('embedding_image_ocr_max_usd', '0');
    _resetOcrRunBudgetForTests({ images: 100_000, estUsd: 500 });
    __setGenerateTextTransportForTests(async () => ({ text: 'stubbed', usage: {} }) as never);
    try {
      await _maybeOcrGatedForTests(engine, buf, 'image/png');
      expect(await engine.getConfig('ocr_skipped_budget')).toBeFalsy();
      expect(_getOcrRunBudgetForTests().images).toBe(100_001);
    } finally {
      __setGenerateTextTransportForTests(null);
    }
  });
});

describe('doctor ocr_health surfaces the budget-skip counter (#3973)', () => {
  test('doctor source reads ocr_skipped_budget and names the raise-cap fix', async () => {
    const { doctorSource } = await import('./helpers/doctor-source.ts');
    const src = doctorSource();
    expect(src).toContain("ocr_skipped_budget");
    expect(src).toContain('embedding_image_ocr_max_images');
    expect(src).toContain('embedding_image_ocr_max_usd');
  });
});
