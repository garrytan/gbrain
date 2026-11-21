/**
 * BrainEngine parity: the field usage sample read of engine-sql/field-usage.ts, which `gbrain schema detect --fields`
 * (schema-pack/field-usage.ts runFieldUsage) used to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readFieldUsageSamples returns the same answer on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts): the live page types of the scope (or the
 *    brain) with their page counts, most pages first and ties by type name, at most `maxTypes` of them; and per type
 *    the frontmatter and compiled_truth of at most `samplePerType` live pages, the oldest pages first. `type` narrows
 *    the read to one type and `countsOnly` answers no sampled pages.
 *  - Regression: an engine that counts soft-deleted pages, ignores the source scope, orders ties differently from the other engines,
 *    samples other pages or drops the type cap gives a different `schema detect --fields` report.
 *  - Pinned as they are on master (TODOS.md): pages of an archived source are counted and sampled, and a segmented
 *    page (body in segments, compiled_truth NULL) is sampled with an empty body, so its fact and relation lines are
 *    not counted.
 *  - Why existing coverage misses it: test/schema-field-usage.test.ts runs the read on PGLite only and never compares
 *    arms.
 *  - Seam: pages through putPage, a second source through the harness `createSource`, an archived source through
 *    `archiveSource` and a segmented page through `publishSegmentedPage`. Page ids are never compared.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { runFieldUsage } from '../../src/core/schema-pack/field-usage.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { publishSegmentedPage, segmentText } from '../helpers/page-body-fixtures.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

function page(type: string, title: string, extra: Partial<PageInput> = {}): PageInput {
  return { type, title, compiled_truth: `${title} body`, timeline: '', frontmatter: {}, ...extra };
}

async function put(engine: BrainEngine, slug: string, input: PageInput, sourceId?: string) {
  await engine.putPage(slug, input, sourceId === undefined ? undefined : { sourceId });
}

describe('engine parity: field usage samples', () => {
  parityTest(
    'readFieldUsageSamples counts live pages per type, most first and ties by name, and samples the oldest pages',
    { methods: ['putPage', 'softDeletePage', 'readFieldUsageSamples'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const empty = await engine.readFieldUsageSamples({ maxTypes: 50, samplePerType: 10 });
      // Ties use names every collation orders the same way; the tie order of mixed-case names is master's (the database collation).
      await put(engine, 'notes/z1', page('beta', 'Z1', { frontmatter: { rank: 1 } }));
      await put(engine, 'notes/a1', page('alpha', 'A1', { frontmatter: { rank: 1 } }));
      for (let i = 1; i <= 3; i++) {
        await put(engine, `people/p${i}`, page('person', `P${i}`, {
          frontmatter: { company: 'Acme', ...(i === 1 ? { role: 'cto' } : {}) },
          compiled_truth: `Person ${i}.\n\n- works_at [[companies/acme-example]]\n${i <= 2 ? '- [preference] Tea\n' : ''}`,
        }));
      }
      await put(engine, 'people/gone', page('person', 'Gone', { frontmatter: { deleted_key: true } }));
      await engine.softDeletePage('people/gone');
      await put(engine, 'people/other', page('person', 'Other', { frontmatter: { other_key: 'x' } }), 'other');
      await put(engine, 'notes/other-only', page('memo', 'Memo', { frontmatter: { memo_key: 'x' } }), 'other');
      const view = (rows: Awaited<ReturnType<BrainEngine['readFieldUsageSamples']>>) => rows.map((t) => ({
        type: t.type, pages: t.pages,
        rows: t.rows.map((r) => ({ frontmatter: r.frontmatter, compiled_truth: r.compiled_truth })),
      }));
      const brain = view(await engine.readFieldUsageSamples({ maxTypes: 50, samplePerType: 10 }));
      const scoped = view(await engine.readFieldUsageSamples({ sourceId: 'default', maxTypes: 50, samplePerType: 10 }));
      const capped = view(await engine.readFieldUsageSamples({ sourceId: 'default', maxTypes: 2, samplePerType: 2 }));
      const counts = view(await engine.readFieldUsageSamples({ sourceId: 'default', maxTypes: 50, samplePerType: 10, countsOnly: true }));
      const onePerson = view(await engine.readFieldUsageSamples({ sourceId: 'default', maxTypes: 1, samplePerType: 10, type: 'person' }));
      const report = await runFieldUsage(engine, { sourceId: 'default' });
      expect(empty).toEqual([]);
      expect(counts).toEqual([{ type: 'person', pages: 3, rows: [] }, { type: 'alpha', pages: 1, rows: [] }, { type: 'beta', pages: 1, rows: [] }]);
      expect(onePerson).toEqual([scoped[0]!]);
      expect(brain.map((t) => `${t.type}:${t.pages}`)).toEqual(['person:4', 'alpha:1', 'beta:1', 'memo:1']);
      expect(scoped.map((t) => `${t.type}:${t.pages}`)).toEqual(['person:3', 'alpha:1', 'beta:1']);
      expect(capped.map((t) => t.type)).toEqual(['person', 'alpha']);
      expect(capped[0]!.rows.map((r) => r.compiled_truth?.split('\n')[0])).toEqual(['Person 1.', 'Person 2.']);
      return { empty, brain, scoped, capped, counts, onePerson, report };
    },
  );

  parityTest(
    'pages of an archived source are counted and sampled, as on master (TODOS.md)',
    { methods: ['putPage', 'readFieldUsageSamples'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'attic');
      await put(engine, 'notes/live', page('note', 'Live', { frontmatter: { status: 'live' } }));
      await put(engine, 'notes/attic', page('note', 'Attic', { frontmatter: { status: 'old', shelf: 3 } }), 'attic');
      await archiveSource(engine, backend, 'attic');
      const brain = await engine.readFieldUsageSamples({ maxTypes: 50, samplePerType: 10 });
      const attic = await engine.readFieldUsageSamples({ sourceId: 'attic', maxTypes: 50, samplePerType: 10 });
      const report = await runFieldUsage(engine);
      expect(brain.map((t) => `${t.type}:${t.pages}:${t.rows.length}`)).toEqual(['note:2:2']);
      expect(attic.map((t) => `${t.type}:${t.pages}`)).toEqual(['note:1']);
      expect(report[0]!.frontmatter.find((f) => f.name === 'shelf')).toEqual({ name: 'shelf', pages: 1, share: 0.5 });
      return { brain, attic, report };
    },
  );

  parityTest(
    'a segmented page is sampled with an empty body, so its fact and relation lines are not counted, as on master (TODOS.md)',
    { methods: ['putPage', 'createSegmentedPageShell', 'readFieldUsageSamples'] },
    async (engine) => {
      await put(engine, 'notes/inline', page('note', 'Inline', {
        frontmatter: { status: 'probe' }, compiled_truth: 'Inline.\n\n- [preference] Tea\n- works_at [[companies/acme-example]]\n',
      }));
      await publishSegmentedPage(engine, 'notes/segmented', [segmentText('# Big\n\n- [preference] Coffee\n- works_at [[companies/widget-co]]\n')]);
      const samples = await engine.readFieldUsageSamples({ maxTypes: 50, samplePerType: 10 });
      const [note] = await runFieldUsage(engine);
      expect(samples.map((t) => `${t.type}:${t.pages}`)).toEqual(['note:2']);
      expect(samples[0]!.rows.map((r) => r.compiled_truth === null)).toEqual([false, true]);
      expect(note!.fact_categories).toEqual([{ name: 'preference', pages: 1, share: 0.5 }]);
      expect(note!.relation_types).toEqual([{ name: 'works_at', pages: 1, share: 0.5 }]);
      return { samples, note };
    },
  );
});
