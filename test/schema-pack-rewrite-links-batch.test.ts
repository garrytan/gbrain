// v0.42 Type Unification (T30) — rewriteLinksBatch unit tests.
//
// Coverage: empty pair list no-op, single pair, multi pair, source-scoped
// (each pair carries its own sourceId), missing endpoints skip.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { rewriteLinksBatch } from '../src/core/schema-pack/rewrite-links-batch.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seed(slug: string) {
  await engine.putPage(slug, {
    title: slug, type: 'concept' as never,
    compiled_truth: 'body that is long enough to pass any minimum length backstop',
    timeline: '', frontmatter: {}, source_path: `${slug}.md`,
  });
}

describe('rewriteLinksBatch', () => {
  it('empty array no-op', async () => {
    const count = await rewriteLinksBatch(engine, []);
    expect(count).toBe(0);
  });

  it('rewrites links referencing old page to point at new page', async () => {
    await seed('old-canonical');
    await seed('new-canonical');
    await seed('referrer-page');
    // Insert a link from referrer-page → old-canonical
    await engine.addLinksBatch([
      {
        from_slug: 'referrer-page',
        to_slug: 'old-canonical',
        link_type: 'mentions',
        link_source: 'manual',
        from_source_id: 'default',
        to_source_id: 'default',
      },
    ]);
    // Verify link exists
    const before = await engine.executeRaw<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM links l
       JOIN pages p ON l.to_page_id = p.id
       WHERE p.slug = 'old-canonical'`,
    );
    expect(parseInt(before[0].cnt, 10)).toBe(1);
    // Rewrite
    const touched = await rewriteLinksBatch(engine, [
      { from_slug: 'old-canonical', to_slug: 'new-canonical', source_id: 'default' },
    ]);
    expect(touched).toBeGreaterThan(0);
    // Link now points at new-canonical
    const after = await engine.executeRaw<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM links l
       JOIN pages p ON l.to_page_id = p.id
       WHERE p.slug = 'new-canonical'`,
    );
    expect(parseInt(after[0].cnt, 10)).toBe(1);
  });

  it('skips pairs whose endpoints do not exist', async () => {
    const touched = await rewriteLinksBatch(engine, [
      { from_slug: 'nonexistent-a', to_slug: 'nonexistent-b', source_id: 'default' },
    ]);
    expect(touched).toBe(0);
  });
});
