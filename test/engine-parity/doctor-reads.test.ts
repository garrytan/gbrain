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
});
