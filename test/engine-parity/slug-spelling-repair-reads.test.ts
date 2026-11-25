/**
 * BrainEngine parity: the reads `gbrain repair slug-spelling` makes (engine-sql/slug-spelling-repair.ts), called directly,
 * and the two apply-only writes it keeps as raw SQL.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1) the server encoding is UTF8,
 *    no brain table has row-level security for the running role, the source row names its checkout and slug-root mode,
 *    the source candidate scan, the same-printed-name read (by index keys and by the ASCII scan key), the page slug
 *    re-check and the page re-read answer the same rows. The apply-only writes (copying purge tombstones and re-keying
 *    attachments) run on PGLite and Postgres and are the typed raw_sql refusal on Rust.
 *  - Regression: these reads were raw SQL in the repair, so on a Rust brain the preview stopped on the raw_sql refusal
 *    before it could say there was nothing to move.
 *  - Why existing coverage misses it: test/repair-slug-spelling*.test.ts run on PGLite and Postgres only.
 *  - Seam: none. Real engines; slugs in normal form only, since the Rust store holds every slug in normal form.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { spellingKeys } from '../../src/core/slug-spelling-key.ts';
import { carryGuards, rekeyAttachments } from '../../src/core/repair/slug-spelling-guards.ts';

const { parityTest } = parityArms(testBackends());

const put = (engine: BrainEngine, slug: string, sourceId = 'default') =>
  engine.putPage(slug, { type: 'note' as never, title: slug, compiled_truth: `${slug} body.`, timeline: '', frontmatter: {} }, { sourceId });

describe('engine parity: the slug-spelling repair reads', () => {
  parityTest('the preview reads answer the same rows on every engine', {
    methods: ['readServerEncoding', 'readRowSecurityBrainTables', 'readSlugRepairSource', 'listSourceSlugSpellingCandidates',
      'readSpellingKeyPages', 'readPageSlugInSource', 'readSlugRepairPage'],
    timeout: 90_000,
  }, async (engine) => {
    await engine.insertSource({ id: 'other-example', name: 'other-example', local_path: '/nonexistent/other', config: { slug_root_mode: 'source-root' } });
    for (const slug of ['notes/plain', 'notes/caf\u00e9', 'notes/cafe', 'people/\u65e5\u672c']) await put(engine, slug);
    await put(engine, 'notes/caf\u00e9', 'other-example');
    await engine.softDeletePage('people/\u65e5\u672c', { sourceId: 'default' });
    const candidates = await engine.listSourceSlugSpellingCandidates('default', 0);
    const cafe = candidates.find(row => row.slug === 'notes/caf\u00e9')!;
    const id = Number(cafe.id);
    const source = (row: Awaited<ReturnType<BrainEngine['readSlugRepairSource']>>) =>
      row && { local_path: row.local_path, slug_root_mode: row.slug_root_mode, incarnation: typeof row.incarnation === 'string' && row.incarnation.length > 0 };
    const pageView = (row: Awaited<ReturnType<BrainEngine['readSlugRepairPage']>>) =>
      row && { same: Number(row.id) === id, slug: row.slug, revision: typeof row.revision === 'string' && row.revision.length > 0, source_path: row.source_path, deleted: row.deleted };
    const slugsOf = (rows: Array<{ slug: string }>) => rows.map(r => r.slug);
    const answers = {
      encoding: await engine.readServerEncoding(),
      rowSecurity: await engine.readRowSecurityBrainTables(),
      source: source(await engine.readSlugRepairSource('default')),
      otherSource: source(await engine.readSlugRepairSource('other-example')),
      noSource: await engine.readSlugRepairSource('no-such-source'),
      candidates: candidates.map(r => ({ slug: r.slug, deleted: r.deleted, source_path: r.source_path, revision: typeof r.revision === 'string' })),
      afterFirst: slugsOf(await engine.listSourceSlugSpellingCandidates('default', id)),
      byKeys: slugsOf(await engine.readSpellingKeyPages('default', spellingKeys('notes/caf\u00e9'), 'notescaf', 0)),
      byKeysOthers: slugsOf(await engine.readSpellingKeyPages('default', spellingKeys('notes/caf\u00e9'), 'notescaf', id)),
      byScan: slugsOf(await engine.readSpellingKeyPages('default', null, 'notescaf', 0)),
      otherByKeys: slugsOf(await engine.readSpellingKeyPages('other-example', spellingKeys('notes/caf\u00e9'), 'notescaf', 0)),
      slug: await engine.readPageSlugInSource(id, 'default'),
      slugElsewhere: await engine.readPageSlugInSource(id, 'other-example'),
      page: pageView(await engine.readSlugRepairPage(id, 'default')),
      pageElsewhere: await engine.readSlugRepairPage(id, 'other-example'),
    };
    expect(answers).toEqual({
      encoding: 'UTF8', rowSecurity: [],
      source: { local_path: null, slug_root_mode: null, incarnation: true },
      otherSource: { local_path: '/nonexistent/other', slug_root_mode: 'source-root', incarnation: true },
      noSource: null,
      candidates: [{ slug: 'notes/caf\u00e9', deleted: false, source_path: null, revision: true }, { slug: 'people/\u65e5\u672c', deleted: true, source_path: null, revision: true }],
      afterFirst: ['people/\u65e5\u672c'],
      byKeys: ['notes/caf\u00e9'], byKeysOthers: [], byScan: ['notes/caf\u00e9'], otherByKeys: ['notes/caf\u00e9'],
      slug: 'notes/caf\u00e9', slugElsewhere: null,
      page: { same: true, slug: 'notes/caf\u00e9', revision: true, source_path: null, deleted: false }, pageElsewhere: null,
    });
    return answers;
  });

  // The two writes only the apply makes (a page under an older spelling moving to its normal slug). The Rust store holds
  // no such page, so it never reaches them; they stay raw SQL and are the typed raw_sql refusal there
  // (docs/designs/RUST_ENGINE.md, the slug-spelling apply row).
  parityTest('the apply-only writes copy purge tombstones and re-key attachments on the SQL engines and refuse typed on Rust', {
    methods: ['putPage'], requires: 'raw_sql', timeout: 90_000,
  }, async (engine) => {
    await put(engine, 'notes/plain');
    const guards = await carryGuards(engine, 'default', 'notes/plain', 'notes/plain-2');
    const attachments = await rekeyAttachments(engine, 'default', 'notes/plain', 'notes/plain-2', 1);
    expect({ guards, attachments }).toEqual({ guards: { fact_purges: 0, take_purges: 0 }, attachments: 0 });
    return { guards, attachments };
  });
});
