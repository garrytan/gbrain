/**
 * GBRA-218: readers normalization parity.
 *
 * 1. Protects: the SQL function gbrain_access_readers() (migration v281),
 *    which every read predicate uses, and normalizeReaders(), which every
 *    TypeScript check (isPrivatePage, isPrivatePageForCaller) uses, return the
 *    same readers for the same frontmatter.
 * 2. Fails when: either side accepts, rejects, trims, case-folds, dedupes or
 *    orders a readable_by value differently, so a page could read as
 *    restricted on one path and open on another.
 * 3. Real seams: the migrated PGLite schema; a generated corpus of valid,
 *    malformed and edge-case values, compared row by row.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { NOBODY, hasReaders, normalizePrincipal, normalizeReaders, readersAllow } from '../src/core/access/principals.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

const ENTRIES = ['alice-example', 'Alice-Example', ' bob-example ', 'member:carol', 'MEMBER:carol', 'group:team-a', 'GROUP:Team-A',
  'group:', 'member:', '', ' ', '\tdan', 'dan\n', 'eve example', 'a.b_c-d', '-lead', '.lead', 'x'.repeat(64), 'y'.repeat(65),
  'group:group:x', 'member:group:x', 'member:member:x', 'k\u212Aelvin', 'caf\u00e9', 'İstanbul', 'zed:z', '0', 'group:0'];

function corpus(): unknown[] {
  const out: unknown[] = [{}, { title: 'x' }, { readable_by: null }, { readable_by: [] }, { readable_by: 7 }, { readable_by: true },
    { readable_by: { member: 'a' } }, { readable_by: ['alice-example', 3] }, { readable_by: ['alice-example', null] },
    { readable_by: Array.from({ length: 256 }, (_, i) => `m${i}`) }, { readable_by: Array.from({ length: 257 }, (_, i) => `m${i}`) },
    { readable_by: ['b', 'a', 'B', 'member:a'] }, { readable_by: ['a.b', 'a-b', 'a_b', 'a0', 'group:a'] }];
  for (const e of ENTRIES) out.push({ readable_by: e }, { readable_by: [e] }, { readable_by: [e, 'alice-example'] });
  for (let i = 0; i < ENTRIES.length; i++) out.push({ readable_by: [ENTRIES[i], ENTRIES[(i * 7 + 3) % ENTRIES.length], ENTRIES[(i * 11 + 5) % ENTRIES.length]] });
  return out;
}

describe('gbrain_access_readers parity', () => {
  test('SQL and TypeScript normalize every corpus value identically', async () => {
    const values = corpus();
    const rows = await engine.executeRaw<{ i: number; readers: string[] | null }>(
      `SELECT (v.ordinality - 1)::int AS i, gbrain_access_readers(v.value) AS readers FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS v`,
      [JSON.stringify(values)]);
    expect(rows.length).toBe(values.length);
    const mismatches = rows.filter(r => JSON.stringify(r.readers) !== JSON.stringify(normalizeReaders(values[r.i])))
      .map(r => ({ value: values[r.i], sql: r.readers, ts: normalizeReaders(values[r.i]) }));
    expect(mismatches).toEqual([]);
  });

  test('a non-object frontmatter names no readers on either side', async () => {
    for (const fm of [null, [], ['readable_by'], 'readable_by', 3]) {
      const [row] = await engine.executeRaw<{ readers: string[] | null }>('SELECT gbrain_access_readers($1::jsonb) AS readers', [JSON.stringify(fm)]);
      expect(row.readers).toBeNull();
      expect(normalizeReaders(fm)).toBeNull();
    }
  });
});

describe('derived page_readers', () => {
  test('a trigger keeps pages.page_readers equal to the normalization on insert, frontmatter change and direct writes', async () => {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', ['ap-src']);
    await engine.putPage('notes/ap-readers', { type: 'note', title: 'A', compiled_truth: 'x', timeline: '', frontmatter: { readable_by: ['Bob-Example', 'group:team-a'] } }, { sourceId: 'ap-src' } as never);
    const read = async () => (await engine.executeRaw<{ r: string[] | null }>("SELECT page_readers AS r FROM pages WHERE slug = 'notes/ap-readers' AND source_id = 'ap-src'"))[0].r;
    expect(await read()).toEqual(['group:team-a', 'member:bob-example']);
    await engine.executeRaw("UPDATE pages SET frontmatter = frontmatter || '{\"readable_by\": \"not valid\"}'::jsonb WHERE slug = 'notes/ap-readers'");
    expect(await read()).toEqual([NOBODY]);
    await engine.executeRaw("UPDATE pages SET page_readers = ARRAY['member:mallory-example'] WHERE slug = 'notes/ap-readers'");
    expect(await read()).toEqual([NOBODY]);
    await engine.executeRaw("UPDATE pages SET frontmatter = frontmatter - 'readable_by' WHERE slug = 'notes/ap-readers'");
    expect(await read()).toBeNull();
  });
});

describe('principal rules', () => {
  test('bare ids are members; prefixes and ASCII case fold; anything else is invalid', () => {
    expect(normalizePrincipal('Alice-Example')).toBe('member:alice-example');
    expect(normalizePrincipal('GROUP:Team-A')).toBe('group:team-a');
    expect(normalizePrincipal('k\u212Aelvin')).toBeNull();
    expect(normalizePrincipal('\tdan')).toBeNull();
    expect(normalizePrincipal('member:group:x')).toBeNull();
  });

  test('a malformed readers value reads as nobody, and nobody is no identity', () => {
    expect(normalizeReaders({ readable_by: ['alice-example', 'not valid'] })).toEqual([NOBODY]);
    expect(readersAllow({ readable_by: 'not valid' }, ['member:alice-example', NOBODY.slice(1)])).toBe(false);
    expect(hasReaders({ readable_by: null })).toBe(true);
    expect(readersAllow({ readable_by: ['group:team-a'] }, ['member:bob-example', 'group:team-a'])).toBe(true);
    expect(readersAllow({ readable_by: ['group:team-a'] }, [])).toBe(false);
    expect(readersAllow({ title: 'open' }, [])).toBe(true);
  });
});
