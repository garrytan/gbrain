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
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromFile, importCodeFile, withImportTransaction } from '../src/core/import-file.ts';

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

/**
 * Caller audit: file-authoritative import paths carry the escape hatch (the
 * file IS the source of truth, so an emptied file is a deliberate clear);
 * agent/LLM-facing writers (put_page op — see put-page-empty-guard.test.ts —
 * BrainWriter, enrichment, reports) do not, so the guard stays armed for
 * exactly the read-empty read-modify-write class it was built for.
 */
describe('putPage empty-overwrite guard — import-path caller audit', () => {
  let engine: PGLiteEngine;
  let tmp: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    tmp = mkdtempSync(join(tmpdir(), 'gbrain-empty-overwrite-'));
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('sync/import of an emptied markdown file clears the body (no throw)', async () => {
    const rel = 'concepts/emptied-on-disk.md';
    const filePath = join(tmp, 'emptied-on-disk.md');
    writeFileSync(filePath, '# Real page\n\nContent the user later deleted.\n');
    const first = await importFromFile(engine, filePath, rel, { noEmbed: true });
    expect(first.status).toBe('imported');
    expect(await storedBody(engine, first.slug)).toContain('Content the user later deleted.');

    // The user empties the file on disk; the next sync/import must treat
    // that as an authoritative clear, not a guarded data-loss overwrite.
    writeFileSync(filePath, '');
    const second = await importFromFile(engine, filePath, rel, { noEmbed: true });
    expect(second.status).toBe('imported');
    expect(((await storedBody(engine, second.slug)) ?? '').trim()).toBe('');
  });

  test('an emptied code file clears the body (no throw)', async () => {
    const rel = 'src/emptied-fixture.ts';
    const first = await importCodeFile(engine, rel, 'export const kept = 1;\n', { noEmbed: true });
    expect(first.status).toBe('imported');
    expect(await storedBody(engine, first.slug)).toContain('kept');

    const second = await importCodeFile(engine, rel, '', { noEmbed: true });
    expect(second.status).toBe('imported');
    expect(((await storedBody(engine, second.slug)) ?? '').trim()).toBe('');
  });

  test('withImportTransaction: guard stays armed unless the spec opts in (image OCR path)', async () => {
    const slug = 'files/photo-page';
    await engine.putPage(slug, body('ocr text from the previous image bytes'));

    const blankPage = { type: 'image' as any, title: 'photo', compiled_truth: '', timeline: '', frontmatter: {} };
    await expect(
      withImportTransaction(engine, { slug, hadExisting: true, page: blankPage }),
    ).rejects.toThrow(/refusing to overwrite non-empty page/);
    expect(await storedBody(engine, slug)).toContain('ocr text');

    // importImageFile sets allowEmptyOverwrite: the image bytes are the
    // source of truth, and a changed image may legitimately OCR to nothing.
    await expect(
      withImportTransaction(engine, { slug, hadExisting: true, page: blankPage, allowEmptyOverwrite: true }),
    ).resolves.toBeUndefined();
    expect(((await storedBody(engine, slug)) ?? '').trim()).toBe('');
  });
});
