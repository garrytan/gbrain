/**
 * EXP-4 producer seam test (codex review #4).
 *
 * The plan called the regex extension worthless without a producer that
 * emits TAKES_HOLDER_INVALID warnings into a sync-failures-shaped record.
 * That producer lives in src/core/cycle/extract-takes.ts (both fs and db
 * paths) and feeds ExtractTakesResult.failedFiles. Without this seam, the
 * v0_28_0 migration's recordSyncFailures call would have nothing to record.
 *
 * This file directly exercises the seam: seed a page with an invalid holder,
 * run extractTakesFromDb, assert failedFiles[] gets the right shape.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractTakesFromDb } from '../src/core/cycle/extract-takes.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

function bodyWithHolder(holder: string, claim = 'a claim'): string {
  return `# Page

## Takes

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | ${claim} | take | ${holder} | 0.5 | 2026-01 | manual |
${TAKES_FENCE_END}
`;
}

describe('extractTakesFromDb — TAKES_HOLDER_INVALID producer seam (codex review #4)', () => {
  test('valid holder produces no failedFiles entry', async () => {
    const slug = 'test/exp4-valid';
    await engine.putPage(slug, {
      type: 'note', title: 't',
      compiled_truth: bodyWithHolder('people/garry-tan'),
      frontmatter: {},
    });
    const result = await extractTakesFromDb(engine, { slugs: [slug] });
    expect(result.takesUpserted).toBeGreaterThanOrEqual(1);
    const holderEntries = result.failedFiles.filter(f => f.error.includes('TAKES_HOLDER_INVALID'));
    expect(holderEntries).toHaveLength(0);
  });

  test('invalid holder (capitalized) populates failedFiles with TAKES_HOLDER_INVALID', async () => {
    const slug = 'test/exp4-invalid-uppercase';
    await engine.putPage(slug, {
      type: 'note', title: 't',
      compiled_truth: bodyWithHolder('Garry'),
      frontmatter: {},
    });
    const result = await extractTakesFromDb(engine, { slugs: [slug] });

    // Row must still be upserted (markdown source-of-truth contract).
    expect(result.takesUpserted).toBeGreaterThanOrEqual(1);

    // failedFiles must contain a TAKES_HOLDER_INVALID record with the slug.
    const matches = result.failedFiles.filter(f => f.error.startsWith('TAKES_HOLDER_INVALID'));
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe(slug);
    expect(matches[0].error).toContain('"Garry"');
  });

  test('invalid holder (world/<slug>) populates failedFiles', async () => {
    const slug = 'test/exp4-invalid-world-slug';
    await engine.putPage(slug, {
      type: 'note', title: 't',
      compiled_truth: bodyWithHolder('world/garry-tan'),
      frontmatter: {},
    });
    const result = await extractTakesFromDb(engine, { slugs: [slug] });
    const matches = result.failedFiles.filter(f => f.error.startsWith('TAKES_HOLDER_INVALID'));
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe(slug);
    expect(matches[0].error).toContain('"world/garry-tan"');
  });

  test('mixed valid + invalid in different pages — only invalid lands in failedFiles', async () => {
    const slugA = 'test/exp4-mixed-valid';
    const slugB = 'test/exp4-mixed-invalid';
    await engine.putPage(slugA, {
      type: 'note', title: 'a',
      compiled_truth: bodyWithHolder('brain', 'analysis claim'),
      frontmatter: {},
    });
    await engine.putPage(slugB, {
      type: 'note', title: 'b',
      compiled_truth: bodyWithHolder('users/garry', 'wrong-prefix claim'),
      frontmatter: {},
    });
    const result = await extractTakesFromDb(engine, { slugs: [slugA, slugB] });
    expect(result.failedFiles).toHaveLength(1);
    expect(result.failedFiles[0].path).toBe(slugB);
    expect(result.failedFiles[0].error).toContain('"users/garry"');
  });

  test('legacy bare-slug holder (v0.32 transition compat) does NOT populate failedFiles', async () => {
    // Production brains shipped with bare-slug holders before the namespaced
    // JSDoc landed. v0.32 keeps them as legacy compat (no warning).
    const slug = 'test/exp4-legacy-bare';
    await engine.putPage(slug, {
      type: 'note', title: 't',
      compiled_truth: bodyWithHolder('garry'),
      frontmatter: {},
    });
    const result = await extractTakesFromDb(engine, { slugs: [slug] });
    const matches = result.failedFiles.filter(f => f.error.includes('TAKES_HOLDER_INVALID'));
    expect(matches).toHaveLength(0);
  });

  test('TAKES_TABLE_MALFORMED warnings do NOT leak into failedFiles (only HOLDER_INVALID)', async () => {
    // failedFiles is scoped to TAKES_HOLDER_INVALID per the v0.32 contract;
    // table-shape errors are non-fatal data-quality signals that surface via
    // result.warnings only.
    const slug = 'test/exp4-malformed';
    const malformedBody = `## Takes

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | only | 4 | cells |
${TAKES_FENCE_END}
`;
    await engine.putPage(slug, {
      type: 'note', title: 't',
      compiled_truth: malformedBody,
      frontmatter: {},
    });
    const result = await extractTakesFromDb(engine, { slugs: [slug] });
    // failedFiles stays empty for malformed-only fences.
    expect(result.failedFiles).toHaveLength(0);
    // The warning still surfaces via result.warnings for progress reporting.
    expect(result.warnings.some(w => w.includes('TAKES_TABLE_MALFORMED'))).toBe(true);
  });

  test('failedFiles entry shape is recordSyncFailures-compatible', async () => {
    // Codex review #4: failedFiles must be hand-able directly to
    // recordSyncFailures(). That signature is Array<{path, error, line?}>.
    const slug = 'test/exp4-shape';
    await engine.putPage(slug, {
      type: 'note', title: 't',
      compiled_truth: bodyWithHolder('Garry'),
      frontmatter: {},
    });
    const result = await extractTakesFromDb(engine, { slugs: [slug] });
    const entry = result.failedFiles[0];
    expect(typeof entry.path).toBe('string');
    expect(typeof entry.error).toBe('string');
    expect(entry.path.length).toBeGreaterThan(0);
    expect(entry.error.length).toBeGreaterThan(0);
  });
});
