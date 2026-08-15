/**
 * An EMPTY source file must still be reindexed, and must get its `source_path`.
 *
 * `reindex-code` guarded with `if (!row.compiled_truth)` and reported
 * `missing compiled_truth`. `!''` is true, so a legitimately empty file — every
 * `__init__.py` in every Python package — was counted as a FAILURE and skipped.
 *
 * That is not cosmetic. The page then never receives `source_path`, and the
 * full-sync reconcile matches deleted files by that column, so the page for a
 * deleted empty file is served forever. It is the exact defect the source_path
 * write exists to close, surviving inside the command written to backfill it.
 *
 * Measured before the fix: 3 pages across 2 real sources, all `__init__.py`,
 * all reported as `missing compiled_truth` by a backfill that reported success.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runReindexCode } from '../src/commands/reindex-code.ts';

let engine: PGLiteEngine;
let prevNudge: string | undefined;

// Timeouts are explicit: PGLite's WASM cold start + initSchema is ~20s, well
// past bun's default hook timeout, and the failure surfaces as a beforeEach
// timeout on a beforeAll that simply had not finished.
beforeAll(async () => {
  prevNudge = process.env.GBRAIN_NO_CODE_MODEL_NUDGE;
  process.env.GBRAIN_NO_CODE_MODEL_NUDGE = '1';
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  if (prevNudge === undefined) delete process.env.GBRAIN_NO_CODE_MODEL_NUDGE;
  else process.env.GBRAIN_NO_CODE_MODEL_NUDGE = prevNudge;
}, 60_000);
beforeEach(async () => { await resetPgliteState(engine); }, 60_000);

/** A code page as it existed BEFORE the source_path write: no path stored. */
async function legacyCodePage(slug: string, file: string, content: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'code' as string,
    page_kind: 'code',
    title: `${file} (python)`,
    compiled_truth: content,
    timeline: '',
    frontmatter: { language: 'python', file },
    content_hash: `hash-${slug}`,
  });
}

const pathOf = async (slug: string): Promise<string | null> => {
  const rows = await engine.executeRaw<{ source_path: string | null }>(
    'SELECT source_path FROM pages WHERE slug = $1', [slug],
  );
  return rows[0]?.source_path ?? null;
};

describe('reindex-code repairs empty files', () => {
  test('an empty file gets its source_path and is not a failure', async () => {
    await legacyCodePage('pkg-__init__-py', 'pkg/__init__.py', '');
    expect(await pathOf('pkg-__init__-py')).toBeNull();   // premise

    const r = await runReindexCode(engine, { force: true, noEmbed: true, yes: true });

    expect(await pathOf('pkg-__init__-py')).toBe('pkg/__init__.py');
    expect(r.failed).toBe(0);
  }, 60_000);

  // CONTROL: a non-empty page must be repaired too, so a green run above can
  // never be explained by "reindex repairs nothing at all".
  test('a non-empty file is repaired the same way', async () => {
    await legacyCodePage('pkg-mod-py', 'pkg/mod.py', 'def f():\n    return 1\n');
    expect(await pathOf('pkg-mod-py')).toBeNull();

    const r = await runReindexCode(engine, { force: true, noEmbed: true, yes: true });

    expect(await pathOf('pkg-mod-py')).toBe('pkg/mod.py');
    expect(r.failed).toBe(0);
  }, 60_000);

  // Why the guard was not merely too strict but unreachable-by-design: the
  // column is NOT NULL, so `compiled_truth` can never actually be missing.
  // `!row.compiled_truth` therefore had exactly one possible subject — the
  // empty string — and every hit it ever reported was a false positive.
  // Written as a test because the first fix I reached for was a null check,
  // and this is what proves that branch is dead rather than defensive.
  test('compiled_truth cannot be null, so the falsy guard had no real target', async () => {
    await legacyCodePage('pkg-broken-py', 'pkg/broken.py', 'x = 1\n');
    await expect(
      engine.executeRaw('UPDATE pages SET compiled_truth = NULL WHERE slug = $1', ['pkg-broken-py']),
    ).rejects.toThrow(/not-null constraint/);
  }, 60_000);
});
