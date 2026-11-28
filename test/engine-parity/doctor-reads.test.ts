/**
 * BrainEngine parity: the doctor reads of engine-sql/doctor-reads.ts, which doctor checks used to run through
 * `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts), so a doctor check reads the same finding on each.
 *  - Regression: an engine whose read drifts (or does not serve it) gives a different doctor status, message or
 *    health score per backend.
 *  - Why existing coverage misses it: the doctor check tests run these reads on PGLite only and never compare arms.
 *  - Contract: the calibration counts (contextual coverage, abandoned takes, applied grades) agree on every arm for
 *    unscoped, `['default']`, an unknown source and `[]` (which names none), including the 0.7 weight floor a stored
 *    REAL 0.7 misses, a month-precision since_date and a soft-deleted page.
 *  - Seam: none. Typed methods only (no executeRaw).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const PAGE_CHILD_TARGETS: readonly string[] = [
  'page_versions.page_id', 'tags.page_id', 'takes.page_id', 'raw_data.page_id', 'timeline_entries.page_id',
  'links.from_page_id', 'links.to_page_id', 'links.origin_page_id', 'files.page_id',
];

async function orphanCounts(engine: BrainEngine): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const target of PAGE_CHILD_TARGETS) out[target] = await engine.countPageChildOrphans({ table: target.split('.')[0]!, col: target.split('.')[1]! });
  return out;
}

async function note(engine: BrainEngine, slug: string): Promise<number> {
  const page = await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '' });
  return page.id;
}

describe('doctor reads', () => {
  parityTest(
    'countPageChildOrphans counts no orphan while every child row has its page, and none after a page delete cascades',
    { methods: ['putPage', 'createVersion', 'addTag', 'addTakesBatch', 'putRawData', 'addTimelineEntry', 'addLink', 'upsertFile',
      'deletePage', 'countPageChildOrphans'] },
    async (engine) => {
      const empty = await orphanCounts(engine);
      const alice = await note(engine, 'people/alice-example');
      const acme = await note(engine, 'companies/acme-example');
      const meeting = await note(engine, 'meetings/2026-04-03');
      const doomed = [alice, acme];
      for (const slug of ['people/alice-example', 'companies/acme-example']) {
        await engine.createVersion(slug);
        await engine.addTag(slug, 'team');
        await engine.putRawData(slug, 'crm', { id: slug });
        await engine.addTimelineEntry(slug, { date: '2026-04-03', summary: `${slug} met` });
      }
      await engine.addTakesBatch(doomed.map((page_id) => ({ page_id, row_num: 1, claim: 'ships in Q3', kind: 'bet' as const, holder: 'self' })));
      await engine.addLink('people/alice-example', 'companies/acme-example', 'works at', 'works_at', 'frontmatter', 'meetings/2026-04-03', 'company');
      await engine.addLink('meetings/2026-04-03', 'people/alice-example', 'attended', 'attended', 'frontmatter', 'companies/acme-example', 'attendees');
      await engine.upsertFile({ page_slug: 'people/alice-example', page_id: alice, filename: 'a.png', storage_path: 'assets/a.png', content_hash: 'h-a' });
      await engine.upsertFile({ page_slug: 'meetings/2026-04-03', page_id: meeting, filename: 'm.png', storage_path: 'assets/m.png', content_hash: 'h-m' });
      const live = await orphanCounts(engine);
      await engine.deletePage('people/alice-example');
      await engine.deletePage('companies/acme-example');
      const deleted = await orphanCounts(engine);
      const zero = Object.fromEntries(PAGE_CHILD_TARGETS.map((t) => [t, 0]));
      expect({ empty, live, deleted }).toEqual({ empty: zero, live: zero, deleted: zero });
      return { empty, live, deleted };
    },
  );

  parityTest(
    'listSchemaPackSourceOverrides reads the named override keys, or every key the LIKE pattern matches, wildcard included',
    { methods: ['setConfig', 'listSchemaPackSourceOverrides'] },
    async (engine) => {
      for (const [key, value] of [
        ['schema_pack.source.docs', 'pack-a'], ['schema_pack.source.gmail', 'pack-b'], ['schema_pack.source.', 'pack-c'],
        ['schemaXpack.source.wild', 'pack-d'], ['schema_pack.sourceX', 'pack-e'], ['Schema_pack.source.upper', 'pack-f'], ['other.key', 'pack-g'],
      ] as const) await engine.setConfig(key, value);
      const byKey = (rows: Array<{ key: string; value: string }>) => [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const all = byKey(await engine.listSchemaPackSourceOverrides(null));
      const scoped = byKey(await engine.listSchemaPackSourceOverrides(['docs', 'missing', 'docs', 'gmail']));
      const none = await engine.listSchemaPackSourceOverrides([]);
      expect({ all, scoped, none }).toEqual({
        all: [
          { key: 'schemaXpack.source.wild', value: 'pack-d' }, { key: 'schema_pack.source.', value: 'pack-c' },
          { key: 'schema_pack.source.docs', value: 'pack-a' }, { key: 'schema_pack.source.gmail', value: 'pack-b' },
        ],
        scoped: [{ key: 'schema_pack.source.docs', value: 'pack-a' }, { key: 'schema_pack.source.gmail', value: 'pack-b' }],
        none: [],
      });
      return { all, scoped, none };
    },
  );

  const SCOPES: ReadonlyArray<readonly string[] | null> = [null, ['default'], ['nowhere'], []];

  parityTest(
    'countContextualCoverage counts live pages by chunker version, safe-chunk fence and contextual mode in scope',
    { methods: ['putPage', 'deletePage', 'countContextualCoverage'] },
    async (engine) => {
      const put = (slug: string, extra: Record<string, unknown>, opts?: Record<string, unknown>) =>
        engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '', ...extra } as never, opts as never);
      const empty = await engine.countContextualCoverage(4, null);
      await put('notes/one', { chunker_version: 1 });
      await put('notes/three', { chunker_version: 3 }, { contextualRetrieval: { mode: 'title', corpusGeneration: 'gen-1' } });
      await put('notes/receipt', { type: 'extract_receipt', chunker_version: 2 });
      await put('code/thing', { page_kind: 'code', chunker_version: 1 });
      await put('notes/gone', { chunker_version: 1 });
      await engine.deletePage('notes/gone');
      const counts: Record<string, unknown> = { empty };
      for (const version of [2, 4]) {
        for (const scope of SCOPES) counts[`${version}:${JSON.stringify(scope)}`] = await engine.countContextualCoverage(version, scope);
      }
      expect(counts['4:[]']).toEqual({ chunker_drift: 0, unsealed: 0, unsealed_code: 0, mode_null: 0 });
      expect(counts['4:null']).toEqual(counts['4:["default"]']);
      // Below 4: the three live markdown pages; below the fence: every live page, one of them code; no mode: notes/one only.
      expect(counts['4:null']).toEqual({ chunker_drift: 3, unsealed: 4, unsealed_code: 1, mode_null: 1 });
      expect((counts['2:null'] as { chunker_drift: number }).chunker_drift).toBe(1);
      return counts;
    },
  );

  parityTest(
    'countAbandonedTakes counts active unresolved unsuperseded convictions dated over a year ago, on the scoped pages',
    { methods: ['putPage', 'deletePage', 'addTakesBatch', 'countAbandonedTakes'] },
    async (engine) => {
      const empty = await engine.countAbandonedTakes(null);
      const live = await note(engine, 'notes/threads');
      const gone = await note(engine, 'notes/threads-gone');
      const take = (page_id: number, row_num: number, extra: Record<string, unknown>) =>
        ({ page_id, row_num, claim: `claim ${row_num}`, kind: 'take', holder: 'self', weight: 0.9, ...extra }) as never;
      await engine.addTakesBatch([
        take(live, 1, { since_date: '2019-01' }),
        take(live, 2, { since_date: '2020-05-05', weight: 0.8 }),
        take(live, 3, { since_date: '2019-01-01', weight: 0.7 }),
        take(live, 4, { since_date: '2999-01-01' }),
        take(live, 5, {}),
        take(live, 6, { since_date: '2019-01-01', active: false }),
        take(live, 7, { since_date: '2019-01-01', superseded_by: 1 }),
        take(gone, 1, { since_date: '2019-02' }),
      ]);
      await engine.deletePage('notes/threads-gone');
      const counts: Record<string, number> = { empty };
      for (const scope of SCOPES) counts[JSON.stringify(scope)] = await engine.countAbandonedTakes(scope);
      // Rows 1 and 2 only: a stored REAL 0.7 is below the 0.7 floor, and the deleted page's take is not counted.
      expect(counts).toEqual({ empty: 0, null: 2, '["default"]': 2, '["nowhere"]': 0, '[]': 0 });
      return counts;
    },
  );

  parityTest(
    'countAppliedTakeGrades counts applied verdicts, on takes of the scoped pages',
    { methods: ['putPage', 'addTakesBatch', 'listTakes', 'insertTakeGrade', 'countAppliedTakeGrades'] },
    async (engine) => {
      const empty = await engine.countAppliedTakeGrades(null);
      const page = await note(engine, 'notes/graded');
      await engine.addTakesBatch([1, 2].map((row_num) => ({ page_id: page, row_num, claim: `claim ${row_num}`, kind: 'take', holder: 'self' }) as never));
      const ids = (await engine.listTakes({ page_id: page })).map((t) => t.id).sort((a, b) => a - b);
      expect(ids.length).toBe(2);
      const grade = (takeId: number, judgeModelId: string, applied: boolean) => engine.insertTakeGrade({
        takeId, promptVersion: 'v1', judgeModelId, evidenceSignature: 'sig', verdict: 'correct', confidence: 0.9, applied,
      });
      await grade(ids[0]!, 'm1', true);
      await grade(ids[0]!, 'm2', true);
      await grade(ids[0]!, 'm3', false);
      await grade(ids[1]!, 'm1', true);
      const counts: Record<string, number> = { empty };
      for (const scope of SCOPES) counts[JSON.stringify(scope)] = await engine.countAppliedTakeGrades(scope);
      expect(counts).toEqual({ empty: 0, null: 3, '["default"]': 3, '["nowhere"]': 0, '[]': 0 });
      return counts;
    },
  );
});
