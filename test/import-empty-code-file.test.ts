/**
 * Regression test for `importCodeFile` skipping empty (0-byte) code files (#840).
 *
 * Before this guard, an empty file produced a page row with empty
 * compiled_truth, which then failed every subsequent `gbrain reindex-code`
 * pass with `missing compiled_truth`. Empty files are legitimate in real
 * repos (stub/placeholder files committed during refactors); the importer
 * skips them the same way it skips files over MAX_FILE_SIZE — and when a
 * previously-imported file BECOMES empty, the stale page is deleted (chunks
 * cascade) instead of ghosting in search, mirroring the markdown importer's
 * empty-content branch.
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

describe('importCodeFile — empty file guard (#840)', () => {
  test('zero-byte content is skipped, not inserted', async () => {
    const result = await importCodeFile(engine, 'src/empty.ts', '', { noEmbed: true });

    expect(result.status).toBe('skipped');
    expect(result.chunks).toBe(0);
    expect(result.error).toBe('empty code file');

    // The skip must short-circuit before any page row is written, otherwise
    // reindex-code will still trip on the missing compiled_truth.
    const page = await engine.getPage(result.slug);
    expect(page).toBeNull();
  });

  test('file that BECOMES empty deletes the stale page instead of ghosting', async () => {
    const first = await importCodeFile(engine, 'src/becomes-empty.ts', 'export const x = 1;\n', { noEmbed: true });
    expect(first.status).toBe('imported');
    expect(await engine.getPage(first.slug)).not.toBeNull();

    const second = await importCodeFile(engine, 'src/becomes-empty.ts', '', { noEmbed: true });
    expect(second.status).toBe('skipped');
    expect(second.error).toBe('empty code file');

    // Stale page (and its chunks, via FK cascade) must be gone.
    expect(await engine.getPage(first.slug)).toBeNull();
    expect(await engine.getChunks(first.slug)).toEqual([]);
  });

  test('non-empty content still imports normally', async () => {
    const result = await importCodeFile(engine, 'src/non-empty.ts', 'export const x = 1;\n', { noEmbed: true });

    expect(result.status).toBe('imported');
    expect(result.chunks).toBeGreaterThan(0);
  });
});
