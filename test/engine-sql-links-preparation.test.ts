/**
 * The link-preparation reads (engine-sql/links-preparation.ts) on PGLite, through the SQL the call sites used to run by hand.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readLiveSlugAliases answers the alias slugs of the source that hold no live page while their canonical page
 *    is live, and answers none on a brain whose `slug_aliases` table is missing; the slug fingerprint members answer exactly
 *    the `count`, `hashtextextended` sum and highest id of the source's pages (a soft-deleted page included), and the
 *    slugs added above an id.
 *  - Regression: a member that counted only live pages, or hashed a different text, would let a stale basename index pass
 *    for current, so a wikilink would resolve against a slug list that no longer matches the brain.
 *  - Why existing coverage misses it: test/auto-link-targeted-probe-2544.test.ts drives the whole put, and the engine-parity
 *    cases (test/engine-parity/links-preparation-fingerprint.test.ts) compare arms, not the members to their statement.
 *  - Seam: raw SQL beside the members (the statement the call site ran) as the oracle, and a dropped table for the missing-table case.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

const page = (title: string) => ({ type: 'note' as const, title, compiled_truth: title, frontmatter: {} });

describe('link-preparation reads', () => {
  test('the slug fingerprint is the count, hash sum and highest id of every page of the source, a soft-deleted one included', async () => {
    for (const slug of ['notes/a', 'notes/é', 'notes/日本', 'notes/gone']) await engine.putPage(slug, page(slug));
    await engine.softDeletePage('notes/gone');
    const oracle = (await engine.executeRaw<{ n: number; h: string; m: number }>(
      `SELECT count(*)::int AS n, coalesce(sum(hashtextextended(slug, 0)), 0)::text AS h, coalesce(max(id), 0)::int AS m FROM pages WHERE source_id=$1`, ['default']))[0]!;
    const all = await engine.readSourceSlugFingerprint('default');
    expect({ n: all.n, h: all.h, m: all.m }).toEqual(oracle);
    expect(oracle.n).toBe(4);
    expect([...all.slugs].sort()).toEqual(['notes/a', 'notes/gone', 'notes/é', 'notes/日本'].sort());
  });

  test('the probe adds up the slugs above an id and leaves the fingerprint of the whole source unchanged', async () => {
    const all = await engine.readSourceSlugFingerprint('default');
    const afterSecond = (await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug='notes/é'`))[0]!.id;
    const probe = await engine.probeSourceSlugFingerprint('default', afterSecond);
    expect({ n: probe.n, h: probe.h, m: probe.m }).toEqual({ n: all.n, h: all.h, m: all.m });
    const above = (await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE id > $1`, [afterSecond])).map((r) => r.slug);
    expect([...probe.added].sort()).toEqual(above.sort());
    expect(probe.added_h).toBe((await engine.executeRaw<{ s: string }>(
      `SELECT coalesce(sum(hashtextextended(slug, 0)), 0)::text AS s FROM pages WHERE id > $1`, [afterSecond]))[0]!.s);
    const none = await engine.probeSourceSlugFingerprint('default', all.m);
    expect(none.added).toEqual([]);
    expect(none.added_h).toBe('0');
    expect(await engine.readSourceSlugFingerprint('empty-source')).toEqual({ n: 0, h: '0', m: 0, slugs: [] });
  });

  test('readLiveSlugAliases answers an alias with no live page whose canonical page is live, and none without the table', async () => {
    await engine.putPage('people/bob-old', page('Bob'));
    await engine.updateSlug('people/bob-old', 'people/bob-new');
    expect(await engine.readLiveSlugAliases('default', ['people/bob-old', 'people/bob-old', 'people/nobody', 'notes/a']))
      .toEqual([{ alias_slug: 'people/bob-old', canonical_slug: 'people/bob-new' }]);
    expect(await engine.readLiveSlugAliases('default', [])).toEqual([]);
    expect(await engine.readLiveSlugAliases('another-source', ['people/bob-old'])).toEqual([]);
    await engine.executeRaw('DROP TABLE slug_aliases');
    expect(await engine.readLiveSlugAliases('default', ['people/bob-old'])).toEqual([]);
  });
});
