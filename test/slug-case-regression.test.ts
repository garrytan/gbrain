/**
 * Regression — a mixed-case slug must round-trip through importFromContent.
 *
 * Pre-fix bug:
 *   - putPage runs validateSlug (→ lowercase) internally, but addTag /
 *     upsertChunks do NOT, and importFromContent passed the caller's original
 *     (mixed-case) slug straight through to every per-page tx call. A slug like
 *     `topics/Mixed-CASE` therefore wrote the page row under the lowercased key
 *     while addTag queried `WHERE slug = 'topics/Mixed-CASE'` — a miss — and
 *     threw `addTag failed: page "..." not found`, rolling back the whole tx.
 *     The row became permanently unwritable under that slug.
 *   - This bit every ingestion source whose IDs carry uppercase (Lark / Feishu
 *     doc tokens are mixed-case base62, GitHub repo paths, etc.), surfacing as a
 *     spurious "Page not found" from `gbrain capture` / `put_page`.
 *
 * Fix: importFromContent normalizes the slug once at the entry point
 * (`slug = validateSlug(slug)`), so putPage / addTag / upsertChunks / the
 * returned slug all agree on casing.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

describe('importFromContent normalizes mixed-case slugs', () => {
  test('mixed-case slug with tags imports cleanly and is retrievable lowercased', async () => {
    const slug = 'topics/Mixed-CASE-Slug';
    const content = [
      '---',
      'title: Mixed Case Slug',
      'type: note',
      'tags: [regression]',
      '---',
      '# Mixed Case Slug',
      'Body content so the chunk path runs too.',
    ].join('\n');

    // Pre-fix this rejected with `addTag failed: page "topics/Mixed-CASE-Slug"
    // not found` and rolled back the import.
    const res = await importFromContent(engine, slug, content, { noEmbed: true });
    expect(res.status).not.toBe('error');

    // Stored under the normalized (lowercased) slug and retrievable.
    const page = await engine.getPage('topics/mixed-case-slug');
    expect(page).not.toBeNull();
    expect(page!.slug).toBe('topics/mixed-case-slug');

    // Tag reconciliation (addTag) succeeded — the part that used to throw.
    const tags = await engine.getTags('topics/mixed-case-slug');
    expect(tags).toContain('regression');
  });
});
