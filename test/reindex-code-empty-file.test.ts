/**
 * An EMPTY source file must still be reindexed, not counted as a failure.
 *
 * `reindex-code` guarded with `if (!row.compiled_truth)` and reported
 * `missing compiled_truth`. `!''` is true, so a legitimately empty file — every
 * `__init__.py` in every Python package — was counted as a FAILURE and skipped.
 * `pages.compiled_truth` is NOT NULL DEFAULT '', so the empty string was the
 * only value that guard could ever fire on (#4902).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runReindexCode } from '../src/commands/reindex-code.ts';

let engine: PGLiteEngine;

// Timeouts are explicit: PGLite's WASM cold start + initSchema is ~20s, well
// past bun's default hook timeout.
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
}, 60_000);
beforeEach(async () => { await resetPgliteState(engine); }, 60_000);

async function codePage(slug: string, file: string, content: string): Promise<void> {
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

// `noEmbed: true` also keeps the code-model nudge quiet (it is gated on
// `!opts.noEmbed`), so no env mutation is needed here.
const opts = { force: true, noEmbed: true, yes: true };

describe('reindex-code handles empty files', () => {
  test('an empty file is reindexed, not counted as a failure', async () => {
    await codePage('pkg-__init__-py', 'pkg/__init__.py', '');

    const r = await runReindexCode(engine, opts);

    expect(r.failed).toBe(0);
    expect(r.reindexed).toBe(1);
  }, 60_000);

  // CONTROL: a non-empty page must be reindexed too, so a green run above can
  // never be explained by "reindex does nothing at all".
  test('a non-empty file is reindexed the same way', async () => {
    await codePage('pkg-mod-py', 'pkg/mod.py', 'def f():\n    return 1\n');

    const r = await runReindexCode(engine, opts);

    expect(r.failed).toBe(0);
    expect(r.reindexed).toBe(1);
  }, 60_000);
});
