/**
 * BrainEngine parity: the git-gap census reads (engine-sql/git-gap-census.ts) that `gbrain sources git-gap` and the
 * doctor db_ahead_of_git / strict_facts_outside_git checks used to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: PGLite and Postgres return the same source row, newest window, page keys and counts, scoped to the asked
 *    source, live pages only; the grouped counts (links by provenance, holds by code, parked targets by kind and code)
 *    come back in bytewise order (COLLATE "C"), NULL codes last. The Rust engine serves no census and refuses every
 *    member by name, never an empty census a caller would read as "nothing outside Git".
 *  - Regression: a Postgres database with a non-C collation listed by_link_source, holds and parked_effects keys in a
 *    different order than PGLite; a Rust brain refused on raw SQL with no member name.
 *  - Why existing coverage misses it: test/sources-git-gap*.test.ts run on PGLite only, whose collation is C.
 *  - Seam: none on the reads. Pages, links and timeline rows use typed writers; fact, hold and parked-effect rows come
 *    from the harness fixture seedGitGapRows.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, seedGitGapRows } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const MEMBERS = ['readGitGapSource', 'readGitGapNewestWindow', 'listGitGapPageKeys', 'countGitGapRowsWithoutFile', 'countGitGapSourceRows'] as const;
const DERIVED = ['markdown', 'frontmatter', 'mentions', 'wikilink-resolved'];
const SRC = 'gg';

async function refusals(engine: BrainEngine): Promise<unknown[]> {
  const calls: Array<() => Promise<unknown>> = [
    () => engine.readGitGapSource(SRC),
    () => engine.readGitGapNewestWindow(SRC, 2),
    () => engine.listGitGapPageKeys(SRC, { afterId: '0' }, 2),
    () => engine.countGitGapRowsWithoutFile(SRC, ['notes/alpha'], ['1']),
    () => engine.countGitGapSourceRows(SRC, { derivedLinkSources: DERIVED, holdOp: 'sync-hold' }),
  ];
  return Promise.all(calls.map(call => call().then(() => null, (e: unknown) => e)));
}

const put = (engine: BrainEngine, slug: string, frontmatter: Record<string, unknown> = {}, sourceId = SRC) =>
  engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '', frontmatter } as never, { sourceId });

describe('git-gap census', () => {
  parityTest(
    'the census reads scope to one source and live pages, group bytewise, and refuse by name on Rust',
    { methods: ['readGitGapSource', 'readGitGapNewestWindow', 'listGitGapPageKeys', 'countGitGapRowsWithoutFile', 'countGitGapSourceRows'] },
    async (engine, backend) => {
      if (backend === 'rust') {
        const errors = await refusals(engine);
        expect(errors.map((e, i) => {
          const refusal = e as { code?: string; detail?: string } | null;
          return { code: refusal?.code, named: refusal?.detail?.includes(`member=${MEMBERS[i]} `) };
        })).toEqual(MEMBERS.map(() => ({ code: 'engine_capability_missing', named: true })));
        throw errors[0];
      }
      expect(await engine.readGitGapSource('no-such-source')).toBeNull();
      await createSource(engine, backend, SRC, {}, '/var/tmp/git-gap-census-fixture');
      const fresh = await engine.readGitGapSource(SRC);
      expect({ ...fresh, incarnation: /^[0-9a-f-]{36}$/.test(fresh?.incarnation ?? '') })
        .toEqual({ local_path: '/var/tmp/git-gap-census-fixture', incarnation: true, live_pages: 0 });

      await put(engine, 'notes/alpha', {}, 'default');
      const ids: Record<string, string> = {};
      for (const [slug, fm] of [['notes/alpha', {}], ['notes/zeta', {}], ['notes/private', { visibility: 'private' }], ['notes/gone', {}], ['notes/beta', {}]] as const) {
        ids[slug] = String((await put(engine, slug, fm)).id);
      }
      await engine.softDeletePage('notes/gone', { sourceId: SRC });
      await seedGitGapRows(engine, backend, SRC, {
        facts: [
          { slug: 'notes/alpha', fenced: true }, { slug: 'notes/alpha', fenced: true }, { slug: 'notes/zeta', fenced: true }, { slug: 'notes/beta', fenced: true },
          { slug: 'notes/private', fenced: false }, { slug: 'notes/alpha', fenced: false, expired: true }, { slug: 'notes/zeta', fenced: false },
          { slug: 'notes/gone', fenced: true }, { slug: 'notes/never', fenced: true },
        ],
        holds: [{ code: 'alpha_code' }, { code: 'Zeta_code' }, { code: 'alpha_code' }, { code: null }, { code: 'Zeta_code', staleIncarnation: true }],
        parked: [{ kind: 'git', codes: ['zeta_err', 'Alpha_err', null, 'Alpha_err'] }, { kind: 'Search', codes: ['b_err'] }],
      });
      await seedGitGapRows(engine, backend, 'default', { facts: [{ slug: 'notes/alpha', fenced: true }, { slug: 'notes/alpha', fenced: false }], holds: [{ code: 'alpha_code' }], parked: [{ kind: 'git', codes: ['zeta_err'] }] });

      const source = await engine.readGitGapSource(SRC);
      const newest = await engine.readGitGapNewestWindow(SRC, 2);
      expect({ live: source?.live_pages, incarnation: source?.incarnation === fresh?.incarnation, newest: newest.pages.map(p => p.id),
        stamped: newest.pages.every(p => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(p.updated_at)), unread: newest.facts_on_unread_pages })
        .toEqual({ live: 4, incarnation: true, newest: [ids['notes/beta'], ids['notes/private']], stamped: true, unread: 3 });

      for (const [from, to, type, linkSource] of [
        ['notes/alpha', 'notes/zeta', 'mentions', 'manual'], ['notes/zeta', 'notes/alpha', 'mentions', 'tag-c'], ['notes/beta', 'notes/alpha', 'mentions', 'tagb'],
        ['notes/alpha', 'notes/beta', 'cites', 'tagb'], ['notes/alpha', 'notes/beta', 'mentions', 'markdown'],
      ] as const) await engine.addLink(from, to, 'ctx', type, linkSource, undefined, undefined, { fromSourceId: SRC, toSourceId: SRC });
      for (const [slug, date] of [['notes/alpha', '2026-01-01'], ['notes/alpha', '2026-01-02'], ['notes/zeta', '2026-01-03'], ['notes/beta', '2026-01-04']] as const) {
        await engine.addTimelineEntry(slug, { date, summary: `${slug} on ${date}` }, { sourceId: SRC });
      }

      const shapeKeys = (rows: Awaited<ReturnType<BrainEngine['listGitGapPageKeys']>>) => rows.map(k => ({
        slug: k.slug, source_id: k.source_id, type: k.type, segmented: k.segmented, lineage_private: k.lineage_private,
        revision: k.revision === null || typeof k.revision === 'string', bytes: k.source_path === null ? k.source_path_bytes === null : k.source_path_bytes === Buffer.byteLength(k.source_path),
      }));
      const first = await engine.listGitGapPageKeys(SRC, { afterId: '0' }, 3);
      const rest = await engine.listGitGapPageKeys(SRC, { afterId: first[first.length - 1]!.id }, 3);
      const picked = await engine.listGitGapPageKeys(SRC, { ids: [ids['notes/beta']!, ids['notes/alpha']!, ids['notes/gone']!] }, 256);
      const key = (slug: string, lineage_private = false) => ({ slug, source_id: SRC, type: 'note', segmented: false, lineage_private, revision: true, bytes: true });
      const keys = { first: shapeKeys(first), rest: shapeKeys(rest), picked: shapeKeys(picked), ordered: first.map(k => k.id) };
      expect(keys).toEqual({
        first: [key('notes/alpha'), key('notes/zeta'), key('notes/private', true)], rest: [key('notes/beta')], picked: [key('notes/alpha'), key('notes/beta')],
        ordered: [ids['notes/alpha'], ids['notes/zeta'], ids['notes/private']],
      });

      const withoutFile = await engine.countGitGapRowsWithoutFile(SRC, ['notes/alpha', 'notes/zeta'], [ids['notes/alpha']!, ids['notes/zeta']!]);
      const none = await engine.countGitGapRowsWithoutFile(SRC, [], []);
      const rows = await engine.countGitGapSourceRows(SRC, { derivedLinkSources: DERIVED, holdOp: 'sync-hold' });
      expect({ withoutFile, none, rows }).toEqual({
        withoutFile: { facts: 3, timeline_entries: 3 },
        none: { facts: 0, timeline_entries: 0 },
        rows: {
          facts_unfenced: 2,
          facts_fence_page_missing: 2,
          links: [{ link_source: 'manual', n: 1 }, { link_source: 'tag-c', n: 1 }, { link_source: 'tagb', n: 2 }],
          holds: [{ code: 'Zeta_code', n: 1 }, { code: 'alpha_code', n: 2 }, { code: null, n: 1 }],
          parked: [{ kind: 'Search', code: 'b_err', targets: 1 }, { kind: 'git', code: 'Alpha_err', targets: 2 }, { kind: 'git', code: 'zeta_err', targets: 1 }, { kind: 'git', code: null, targets: 1 }],
        },
      });
      const { incarnation: _incarnation, ...stable } = source!;
      return { stable, newest: { count: newest.pages.length, unread: newest.facts_on_unread_pages }, keys: { first: keys.first, rest: keys.rest, picked: keys.picked }, withoutFile, none, rows };
    },
  );
});
