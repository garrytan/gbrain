/**
 * Issue #2682: image OCR failures must surface instead of silently landing
 * as filename/stub chunks with `errors=0`.
 *
 * Quarantined as *.serial.test.ts because `mock.module` leaks across files
 * in the same shard process (R2 in scripts/check-test-isolation.sh) — this
 * file stubs `src/core/embedding.ts` (so `importImageFile`'s multimodal embed
 * call doesn't need a real Voyage key) and `src/core/ai/gateway.ts` (so the
 * OCR call itself can be forced to succeed or fail deterministically).
 *
 * Covers:
 *   - OCR succeeds: no `ocrFailed` flag, real OCR text lands in chunk_text.
 *   - OCR API call throws: `status` stays 'imported' (fail-open, unchanged
 *     data-path behavior) but `ocrFailed`/`ocrError` are now populated.
 *   - No expansion model configured (`isAvailable` false): same surfacing,
 *     `reason: 'no_key'`.
 *   - `runImport` (src/commands/import.ts) counts OCR failures into a
 *     dedicated `ocrWarnings` counter, separate from `errors` — reproducing
 *     (as a revert-check) that pre-fix code reports `ocrWarnings === 0` /
 *     `errors === 0` for a run where every image's OCR call failed.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

// import-file.ts's `importImageFile` statically imports `embedMultimodal`
// from `./embedding.ts`. Stub it out so `noEmbed: false` (required to reach
// the OCR call — `noEmbed: true` short-circuits OCR too) doesn't need a real
// Voyage API key.
mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async () => [],
  // content_chunks.embedding_image is vector(1024) — the fake vector must
  // match dims or PGLite/pgvector rejects the insert.
  embedMultimodal: async () => [new Float32Array(1024)],
  currentEmbeddingSignature: () => 'test-sig',
}));

// import-file.ts's `maybeOcr` dynamic-imports `./ai/gateway.ts` for
// `isAvailable` + `generateOcrText`. Stub both so the test controls
// success/failure without a real API key or network call.
let ocrAvailable = true;
let ocrShouldFail = false;
let ocrFailureMessage = 'insufficient_quota: mock OCR provider error';
mock.module('../src/core/ai/gateway.ts', () => ({
  isAvailable: () => ocrAvailable,
  generateOcrText: async () => {
    if (ocrShouldFail) throw new Error(ocrFailureMessage);
    return 'mock OCR extracted text';
  },
  // runImport's embed-credential preflight (src/core/embed-preflight.ts)
  // calls diagnoseEmbedding() before processing any file. Only the
  // importImageFile-level tests need noEmbed:false to reach the OCR call —
  // stub this to 'ok' so the runImport-level tests don't need real
  // embedding credentials either.
  diagnoseEmbedding: () => ({ ok: true, model: 'mock-model', provider: 'mock-provider', recipeId: 'mock-recipe' }),
}));

const { importImageFile } = await import('../src/core/import-file.ts');
const { runImport } = await import('../src/commands/import.ts');

let engine: PGLiteEngine;
let tmpDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-ocr-failopen-test-'));
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  ocrAvailable = true;
  ocrShouldFail = false;
  ocrFailureMessage = 'insufficient_quota: mock OCR provider error';
});

describe('importImageFile OCR outcome surfacing (issue #2682)', () => {
  test('OCR succeeds: chunk_text holds real OCR text, no ocrFailed flag', async () => {
    await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: 'true' }, async () => {
      const target = join(tmpDir, 'ocr-ok.png');
      writeFileSync(target, Buffer.from('fake-png-bytes-ocr-ok'));

      const result = await importImageFile(engine, target, 'photos/ocr-ok.png', { noEmbed: false });

      expect(result.status).toBe('imported');
      expect(result.ocrFailed).toBeUndefined();
      expect(result.ocrError).toBeUndefined();

      const chunks = await engine.getChunks('photos/ocr-ok.png');
      expect(chunks[0].chunk_text).toBe('mock OCR extracted text');
    });
  });

  test('OCR API call fails: import still succeeds (fail-open) but ocrFailed/ocrError surface', async () => {
    await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: 'true' }, async () => {
      ocrShouldFail = true;
      ocrFailureMessage = 'insufficient-credit: mock Anthropic OCR error';
      const target = join(tmpDir, 'ocr-fail.png');
      writeFileSync(target, Buffer.from('fake-png-bytes-ocr-fail'));

      const result = await importImageFile(engine, target, 'photos/ocr-fail.png', { noEmbed: false });

      // Fail-open: the file still imports (existing design — see maybeOcr's
      // "never fail the import" contract). This test would have failed
      // before the #2682 fix because ocrFailed/ocrError didn't exist yet —
      // the pre-fix ImportResult had no way to represent this state.
      expect(result.status).toBe('imported');
      expect(result.chunks).toBe(1);
      expect(result.ocrFailed).toBe(true);
      expect(result.ocrError).toContain('api_error');
      expect(result.ocrError).toContain('insufficient-credit: mock Anthropic OCR error');

      // The chunk still falls back to the filename stub (unchanged data path).
      const chunks = await engine.getChunks('photos/ocr-fail.png');
      expect(chunks[0].chunk_text).toBe('ocr-fail.png');
    });
  });

  test('no expansion model available: ocrFailed surfaces with reason no_key', async () => {
    await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: 'true' }, async () => {
      ocrAvailable = false;
      const target = join(tmpDir, 'ocr-nokey.png');
      writeFileSync(target, Buffer.from('fake-png-bytes-ocr-nokey'));

      const result = await importImageFile(engine, target, 'photos/ocr-nokey.png', { noEmbed: false });

      expect(result.status).toBe('imported');
      expect(result.ocrFailed).toBe(true);
      expect(result.ocrError).toContain('no_key');
    });
  });

  test('OCR opted out (env unset): no ocrFailed flag, filename stub as before', async () => {
    await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: undefined }, async () => {
      const target = join(tmpDir, 'ocr-off.png');
      writeFileSync(target, Buffer.from('fake-png-bytes-ocr-off'));

      const result = await importImageFile(engine, target, 'photos/ocr-off.png', { noEmbed: false });

      expect(result.status).toBe('imported');
      expect(result.ocrFailed).toBeUndefined();
      const chunks = await engine.getChunks('photos/ocr-off.png');
      expect(chunks[0].chunk_text).toBe('ocr-off.png');
    });
  });
});

describe('runImport OCR-warning aggregation (issue #2682)', () => {
  test('OCR failures on every image are counted in ocrWarnings, NOT in errors — ' +
       'reproducing the reported errors=0 silent-failure bug as a revert-check', async () => {
    await withEnv({
      GBRAIN_EMBEDDING_IMAGE_OCR: 'true',
      GBRAIN_EMBEDDING_MULTIMODAL: 'true',
    }, async () => {
      ocrShouldFail = true;
      const importDir = mkdtempSync(join(tmpdir(), 'gbrain-ocr-run-import-'));
      writeFileSync(join(importDir, 'a.png'), Buffer.from('fake-png-a'));
      writeFileSync(join(importDir, 'b.png'), Buffer.from('fake-png-b'));

      const result = await runImport(engine, [importDir], { sourceId: 'default' });

      expect(result.imported).toBe(2);
      // The bug this issue reports: errors stayed 0 even though every OCR
      // call failed. That must still hold — OCR failure is fail-open, not a
      // hard error — but it must no longer be INVISIBLE.
      expect(result.errors).toBe(0);
      expect(result.ocrWarnings).toBe(2);
    });
  });

  test('OCR succeeding leaves ocrWarnings at 0', async () => {
    await withEnv({
      GBRAIN_EMBEDDING_IMAGE_OCR: 'true',
      GBRAIN_EMBEDDING_MULTIMODAL: 'true',
    }, async () => {
      const importDir = mkdtempSync(join(tmpdir(), 'gbrain-ocr-run-import-ok-'));
      writeFileSync(join(importDir, 'c.png'), Buffer.from('fake-png-c'));

      const result = await runImport(engine, [importDir], { sourceId: 'default' });

      expect(result.imported).toBe(1);
      expect(result.errors).toBe(0);
      expect(result.ocrWarnings).toBe(0);
    });
  });
});
