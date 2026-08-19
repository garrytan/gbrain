/**
 * putPage empty-overwrite data-loss guard.
 *
 * A page edit is a read-modify-write (read the page, change it, put it back).
 * When the read intermittently returns empty, the modify lands on nothing and
 * putPage's `ON CONFLICT ... SET compiled_truth = EXCLUDED.compiled_truth`
 * blanks the body over real content — silent data loss. Observed in
 * production: a live task/notes page wiped down to just its frontmatter,
 * caught only because the agent re-read and rebuilt it by hand.
 *
 * putPage now refuses to overwrite a non-empty page body with a blank one.
 * These pin the four cases: it blocks the destructive overwrite, still allows
 * a genuinely new empty page, still allows a deliberate clear via
 * allowEmptyOverwrite, and never false-positives on a normal non-empty edit.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const SLUG = 'projects/suzanne-tasks';

function body(text: string) {
  return { type: 'note' as any, title: SLUG, compiled_truth: text, timeline: '', frontmatter: {} };
}

async function storedBody(engine: PGLiteEngine, slug: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ compiled_truth: string | null }>(
    `SELECT compiled_truth FROM pages WHERE slug = $1 AND source_id = 'default' AND deleted_at IS NULL`,
    [slug],
  );
  return rows[0]?.compiled_truth ?? null;
}

describe('putPage empty-overwrite guard', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('refuses to blank a non-empty page body', async () => {
    await engine.putPage(SLUG, body('- [ ] real task one\n- [ ] real task two'));

    await expect(engine.putPage(SLUG, body(''))).rejects.toThrow(/refusing to overwrite non-empty page/);
    await expect(engine.putPage(SLUG, body('   \n  '))).rejects.toThrow(/refusing to overwrite non-empty page/);

    // The real content survived the rejected writes.
    expect(await storedBody(engine, SLUG)).toContain('real task one');
  });

  test('allows a genuinely new empty page (no existing content to lose)', async () => {
    const fresh = 'projects/brand-new-empty';
    await expect(engine.putPage(fresh, body(''))).resolves.toBeDefined();
    expect(await storedBody(engine, fresh)).toBe('');
  });

  test('allows a deliberate clear via allowEmptyOverwrite', async () => {
    const slug = 'projects/intentional-clear';
    await engine.putPage(slug, body('content to be cleared'));
    await expect(engine.putPage(slug, body(''), { allowEmptyOverwrite: true })).resolves.toBeDefined();
    expect(await storedBody(engine, slug)).toBe('');
  });

  test('never blocks a normal non-empty edit', async () => {
    const slug = 'projects/normal-edit';
    await engine.putPage(slug, body('first version'));
    await expect(engine.putPage(slug, body('second version'))).resolves.toBeDefined();
    expect(await storedBody(engine, slug)).toBe('second version');
  });
});
