/**
 * Regression test for `importCodeFile` skipping empty (0-byte) code files.
 *
 * Before this guard, an empty file produced a page row with NULL
 * compiled_truth, which then failed every subsequent `gbrain reindex-code`
 * pass with `missing compiled_truth`. Empty files are legitimate in real
 * repos (stub/placeholder files committed during refactors); the importer
 * should skip them cleanly the same way it skips files over MAX_FILE_SIZE.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('importCodeFile — empty file guard', () => {
  test('zero-byte content is skipped, not inserted', async () => {
    const result = await importCodeFile(engine, 'src/empty.ts', '');

    expect(result.status).toBe('skipped');
    expect(result.chunks).toBe(0);
    expect(result.error).toBe('empty code file');

    // The skip must short-circuit before any page row is written, otherwise
    // reindex-code will still trip on the NULL compiled_truth.
    const page = await engine.getPage(result.slug);
    expect(page).toBeNull();
  });

  test('non-empty content still imports normally', async () => {
    const result = await importCodeFile(
      engine,
      'src/non-empty.ts',
      'export const x = 1;\n',
    );

    expect(result.status).toBe('imported');
    expect(result.chunks).toBeGreaterThan(0);
  });
});
