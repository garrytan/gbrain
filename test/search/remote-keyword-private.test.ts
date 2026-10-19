/**
 * Search must retain every private-page rule while choosing a cheaper plan.
 * A shortcut that admits questions or skips lineage breaks these real-engine
 * rank/count assertions. Existing privacy suites do not exercise all rules
 * across page paging, counts and the hybrid keyword arm together. No new seam.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { buildKeywordCountStatement, buildKeywordPagesStatement } from '../../src/core/search/keyword-statement.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { privatePagesFilterFragment, resolveExcludePrivatePages, __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const specs: Array<[string, string, Record<string, unknown>, boolean]> = [
  ['ordinary', 'note', {}, false],
  ['private', 'note', { visibility: 'private' }, true],
  ['atom-private-origin', 'atom', { visibility: 'world', source_slug: 'notes/private' }, true],
  ['atom-public-origin', 'atom', { visibility: 'world', source_slug: 'notes/ordinary' }, false],
  ['atom-unstamped', 'atom', {}, true],
  ['concept-private-input', 'concept', { visibility: 'world', synthesized_by: 'fixture' }, true],
  ['concept-private-origin', 'concept', { visibility: 'world', synthesized_by: 'fixture' }, true],
  ['concept-unstamped', 'concept', { synthesized_by: 'fixture' }, true],
  ['concept-ordinary', 'concept', {}, false],
  ['question-unstamped', 'question', {}, true],
  ['question-world', 'question', { visibility: 'world' }, false],
  ['pinned', 'question', { visibility: 'world', pinned_question: 'fixture' }, true],
  ['pinned-null', 'note', { pinned_question: null }, true],
  ['event-private', 'event', { captured_via: 'life-chronicle:meeting', event: { depth: 'notes/private' } }, true],
  ['event-missing', 'event', { captured_via: 'life-chronicle:meeting', event: { depth: 'notes/missing' } }, true],
  ['event-lineage', 'event', { captured_via: 'life-chronicle:meeting', event: { depth: 'notes/lineage-string' } }, true],
  ['event-public', 'event', { captured_via: 'life-chronicle:meeting', event: { depth: 'notes/ordinary' } }, false],
  ['lineage-string', 'note', { derived_from: 'notes/private' }, true],
  ['lineage-array', 'note', { derived_from: ['notes/ordinary', 'notes/private.md'] }, true],
  ['lineage-missing', 'note', { derived_from: 'notes/missing' }, false],
  ['lineage-foreign', 'note', { derived_from: 'notes/foreign' }, false],
  ['null-fields', 'note', { visibility: null, derived_from: null }, false],
];

test('remote keyword search orders candidates independently before checking privacy', () => {
  const remote = { excludePrivate: true };
  const rank = buildKeywordPagesStatement('planneedle', remote, { limit: 10 })!.sql;
  const count = buildKeywordCountStatement('planneedle', remote)!.sql;
  expect(rank).toContain('FROM (SELECT * FROM best ORDER BY score DESC, page_id ASC OFFSET 0) b');
  expect(count.indexOf('CROSS JOIN LATERAL')).toBeLessThan(count.indexOf(' WHERE cc.search_vector'));
  expect(count.indexOf(') private_page')).toBeLessThan(count.indexOf('LIMIT 10001'));
  for (const sql of [rank, count]) {
    expect(sql).toContain(`CROSS JOIN LATERAL (SELECT true WHERE ${privatePagesFilterFragment('p')} OFFSET 0) private_page`);
    expect(sql).toContain('p.chunker_version >= 4');
  }
  expect(buildKeywordPagesStatement('planneedle', {}, { limit: 10 })!.sql).not.toContain('LATERAL');
});

for (const kind of testBackends()) describe(`remote keyword privacy (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      close = () => engine.disconnect();
    }
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('side', 'side')`);
    await engine.putPage('notes/foreign', { type: 'note', title: 'Foreign', compiled_truth: 'planneedle', frontmatter: { visibility: 'private' } }, { sourceId: 'side' });
    for (const [name, type, frontmatter] of specs) {
      const slug = `notes/${name}`;
      await engine.putPage(slug, { type, title: name, compiled_truth: 'planneedle', frontmatter });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: 'planneedle', chunk_source: 'compiled_truth' }]);
    }
    for (const [concept, input] of [['concept-private-input', 'private'], ['concept-private-origin', 'atom-private-origin']]) {
      await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
        SELECT a.id, b.id, 'synthesized_from', 'concept-provenance' FROM pages a, pages b
        WHERE a.source_id = 'default' AND b.source_id = 'default' AND a.slug = $1 AND b.slug = $2`, [`notes/${concept}`, `notes/${input}`]);
    }
  }, 120_000);

  afterAll(async () => { __resetPrivateVisibilityCacheForTests(); await close?.(); });

  const opts = { sourceIds: ['default'], limit: 100 };
  const slugs = (rows: Array<{ slug: string }>) => rows.map(r => r.slug);
  const visible = specs.filter(s => !s[3]).map(s => `notes/${s[0]}`);
  // Pinned pages never participate in retrieval, even with the privacy opt-out.
  const local = specs.filter(s => !s[2].hasOwnProperty('pinned_question')).map(s => `notes/${s[0]}`);

  test('keyword ranks and strict counts apply every visibility rule before paging', async () => {
    const remote = { ...opts, excludePrivate: true };
    expect(slugs(await engine.searchKeyword('planneedle', remote))).toEqual(visible);
    expect(slugs(await engine.searchKeywordPages('planneedle', remote, { limit: 100 }))).toEqual(visible);
    expect(await engine.countKeywordPages('planneedle', remote)).toBe(visible.length);
    expect(slugs(await engine.searchKeywordPages('planneedle', remote, { limit: 3, offset: 2 }))).toEqual(visible.slice(2, 5));
    const first = await engine.searchKeywordPages('planneedle', remote, { limit: 2 });
    expect(slugs(await engine.searchKeywordPages('planneedle', remote, {
      limit: 3, after: { score: first[1]!.score, page_id: first[1]!.page_id! },
    }))).toEqual(visible.slice(2, 5));
    expect(slugs(await engine.searchKeyword('planneedle', opts))).toEqual(local);
    expect(await engine.countKeywordPages('planneedle', opts)).toBe(local.length);
  });

  test('the hybrid keyword arm retains the same private-page boundary', async () => {
    // No provider is configured: this exercises the real keyword/title path.
    const rows = await hybridSearch(engine, 'planneedle', { ...opts, excludePrivate: true, expansion: false });
    expect(slugs(rows).sort()).toEqual([...visible].sort());
  });

  if (kind === 'postgres') test('the hybrid keyword statement checks privacy before its chunk pool limit', async () => {
    const options = (engine as unknown as { sql: { options: { debug?: (...args: any[]) => void } } }).sql.options;
    const previous = options.debug;
    let statement = '';
    options.debug = (_id: number, sql: string) => { if (sql.includes('WITH ranked_chunks AS')) statement = sql; };
    try {
      expect(slugs(await engine.searchKeyword('planneedle', { ...opts, excludePrivate: true }))).toEqual(visible);
    } finally { options.debug = previous; }
    expect(statement).toContain('SELECT private_candidates.page_id, private_candidates.chunk_id, private_candidates.score FROM (');
    expect(statement).toContain(`WHERE ${privatePagesFilterFragment('private_candidate_page')} OFFSET 0`);
    expect(statement.indexOf(') private_page')).toBeLessThan(statement.indexOf('LIMIT $'));
  });

  test('search visibility equivalence across metadata combinations', async () => {
    const ids = await engine.executeRaw<{ slug: string; id: number }>('SELECT slug, id FROM pages WHERE source_id = $1', ['default']);
    const id = (name: string) => Number(ids.find(r => r.slug === `notes/${name}`)!.id);
    const cases: Array<{ id: number; type: string; source_id: string; frontmatter: Record<string, unknown> }> = [];
    for (const type of ['note', 'person', 'atom', 'concept', 'question', 'event'])
      for (const visibility of [undefined, null, 'world', 'private', 'local'])
        for (const lineage of ['ordinary', 'private', 'missing', 'foreign']) {
          const origin = `notes/${lineage}`;
          for (const derived_from of [undefined, null, 42, origin, `${origin}.md`, [origin], ['notes/ordinary', origin, null]])
            for (const pinned_question of [undefined, null, 'fixture'])
              for (const synthesized_by of [undefined, null, 'fixture'])
                for (const captured_via of [undefined, 'life-chronicle:meeting', 'other']) {
                  cases.push({ id: id(lineage === 'private' ? 'concept-private-input' : 'ordinary'), type, source_id: 'default',
                    frontmatter: { visibility, derived_from, pinned_question, synthesized_by, captured_via, source_slug: origin, event: { depth: origin } } });
                }
        }
    const statement = buildKeywordPagesStatement('planneedle', { excludePrivate: true }, { limit: 10 })!.sql;
    const start = statement.indexOf('CROSS JOIN LATERAL');
    const end = statement.indexOf(') private_page', start) + ') private_page'.length;
    expect(start).toBeGreaterThan(0);
    const join = statement.slice(start, end);
    let checked = 0;
    let readable = 0;
    for (let at = 0; at < cases.length; at += 500) {
      const [result] = await engine.executeRaw<{ checked: number; mismatches: number; readable: number }>(`
        SELECT count(*)::int AS checked,
          count(*) FILTER (WHERE ((${privatePagesFilterFragment('p')}) IS TRUE) IS DISTINCT FROM actual.visible)::int AS mismatches,
          count(*) FILTER (WHERE actual.visible)::int AS readable
        FROM jsonb_to_recordset($1::text::jsonb) AS p(id bigint, type text, source_id text, frontmatter jsonb)
        CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM (VALUES (1)) seed ${join}) AS visible) actual`, [JSON.stringify(cases.slice(at, at + 500))]);
      expect(result!.mismatches).toBe(0);
      checked += Number(result!.checked);
      readable += Number(result!.readable);
    }
    expect(checked).toBe(22_680);
    expect(readable).toBeGreaterThan(0);
    expect(readable).toBeLessThan(checked);
  }, 120_000);

  test('the remote-private-pages operator opt-out keeps the local result set', async () => {
    await engine.setConfig('search.remote_private_pages', 'visible');
    __resetPrivateVisibilityCacheForTests();
    try {
      const excludePrivate = await resolveExcludePrivatePages(engine, true);
      expect(excludePrivate).toBe(false);
      expect(slugs(await engine.searchKeyword('planneedle', { ...opts, excludePrivate }))).toEqual(local);
      expect(slugs(await engine.searchKeywordPages('planneedle', { ...opts, excludePrivate }, { limit: 100 }))).toEqual(local);
      expect(await engine.countKeywordPages('planneedle', { ...opts, excludePrivate })).toBe(local.length);
      const hybrid = await hybridSearch(engine, 'planneedle', { ...opts, excludePrivate, expansion: false });
      expect(slugs(hybrid).sort()).toEqual([...local].sort());
    } finally {
      await engine.setConfig('search.remote_private_pages', '');
      __resetPrivateVisibilityCacheForTests();
    }
  });
});
