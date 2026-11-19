/**
 * BrainEngine parity — owner_only family (ownerOnlyMarkTriggers and the owner-only marks, GST-3032).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every arm reports the owner-only delete triggers (migration v322) that are missing and whether
 *    owner-only lineage reads closed, and `ensure` recreates a trigger on a table the role owns. A hard delete of an
 *    owner-only page, fact, take or timeline entry marks every row derived from it, so a non-owner still cannot read
 *    the derived row once its origin is gone; a delete of an open row marks nothing.
 *  - Regression: an engine that reports a fresh brain's triggers as missing (so every migration run warns and doctor
 *    fails), whose `ensure` leaves an owned trigger missing, or whose delete leaves no mark (so a page built from a
 *    deleted owner-only take, fact or timeline entry reads as open to every member).
 *  - Why existing coverage misses it: test/owner-only-removal-lineage.test.ts runs the lineage end to end per engine
 *    but never compares the arms' answers, and it reads the SQL lineage functions with raw SQL.
 *  - Seam: none. Real engines; the dropped-trigger case drops a trigger with raw SQL, so it requires raw_sql. The
 *    lineage cases use typed members only and read through readPageHiddenFromCaller under the function form.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { recordDerivationInputs } from '../../src/core/facts/derivation-inputs.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'Marks note', compiled_truth: 'An owner-only marks example.', timeline: '' };
const VAULT = 'marks-vault';
const ORIGIN = 'notes/marks-origin';
const OPEN = 'notes/marks-open';

/** Whether a non-owner reads each `default` page in `slugs`, under the function form (schema 322 or later). */
async function hiddenFrom(engine: BrainEngine, slugs: readonly string[]): Promise<Record<string, boolean>> {
  noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
  return withEngineScope(engine, async () => {
    const hidden: Record<string, boolean> = {};
    for (const slug of slugs) hidden[slug] = await engine.readPageHiddenFromCaller('default', slug, { policy: 'read' });
    return hidden;
  });
}

/**
 * An owner-only page ORIGIN in VAULT with two takes, a timeline entry and a fence fact, an open page OPEN in `default`
 * with one take and one fact, and in `default` one page derived from each of those rows (`notes/marks-from-<row>`).
 */
async function seedLineage(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<string[]> {
  await createSource(engine, backend, VAULT, { owner_only: true });
  const origin = (await engine.putPage(ORIGIN, NOTE, { sourceId: VAULT })).id;
  const open = (await engine.putPage(OPEN, NOTE)).id;
  const take = (page: number, row: number) => ({ page_id: page, row_num: row, claim: `Marks take ${page}/${row}`, kind: 'take' as const, holder: 'world', weight: 0.5 });
  await engine.addTakesBatch([take(origin, 1), take(origin, 2), take(open, 1)]);
  const takeId = async (page: number, row: number) => (await engine.listTakes({ page_id: page, active: undefined })).find(t => t.row_num === row)!.id;
  await engine.addTimelineEntry(ORIGIN, { date: '2026-07-01', summary: 'Marks event' }, { sourceId: VAULT });
  const entry = (await engine.getTimeline(ORIGIN, { sourceId: VAULT }))[0]!.id;
  const fence = (slug: string, fact: string) => ({ row_num: 1, source_markdown_slug: slug, fact, entity_slug: slug, source: 'fence' });
  const [vaultFact] = (await engine.insertFacts([fence(ORIGIN, 'Marks vault claim')], { source_id: VAULT })).ids;
  const [openFact] = (await engine.insertFacts([fence(OPEN, 'Marks open claim')], { source_id: 'default' })).ids;
  const inputs: Record<string, { table: string; id: number }> = {
    'take-1': { table: 'takes', id: await takeId(origin, 1) },
    'take-2': { table: 'takes', id: await takeId(origin, 2) },
    entry: { table: 'timeline_entries', id: entry },
    fact: { table: 'facts', id: vaultFact! },
    'open-take': { table: 'takes', id: await takeId(open, 1) },
    'open-fact': { table: 'facts', id: openFact! },
  };
  const slugs: string[] = [];
  for (const [name, input] of Object.entries(inputs)) {
    const slug = `notes/marks-from-${name}`;
    const id = (await engine.putPage(slug, NOTE)).id;
    await recordDerivationInputs(engine, { table: 'pages', id: String(id), sourceId: 'default' }, [{ table: input.table, id: String(input.id) }]);
    slugs.push(slug);
  }
  return slugs;
}

describe('engine parity: owner_only', () => {
  parityTest('ownerOnlyMarkTriggers finds every delete trigger on a fresh brain', { methods: ['ownerOnlyMarkTriggers'] }, async (engine) => {
    const read = await engine.ownerOnlyMarkTriggers();
    const ensured = await engine.ownerOnlyMarkTriggers({ ensure: true });
    const answers = [read, ensured].map(s => ({ missing: s.missing, closed: s.closed }));
    expect(answers).toEqual([{ missing: [], closed: false }, { missing: [], closed: false }]);
    return answers;
  });

  parityTest(
    'ownerOnlyMarkTriggers names a dropped trigger and ensure recreates it on a table the role owns',
    { methods: ['executeRaw', 'ownerOnlyMarkTriggers'], requires: 'raw_sql' },
    async (engine) => {
      await engine.executeRaw('DROP TRIGGER gbrain_owner_only_row_deleted_trg ON takes');
      const read = await engine.ownerOnlyMarkTriggers();
      const ensured = await engine.ownerOnlyMarkTriggers({ ensure: true });
      const answers = [read, ensured].map(s => ({ missing: s.missing.map(m => ({ table: m.table, owned: m.owned })), closed: s.closed }));
      expect(answers).toEqual([{ missing: [{ table: 'takes', owned: true }], closed: false }, { missing: [], closed: false }]);
      return answers;
    },
  );

  // Fail-first for the owner-only marks: the Rust arm refused ownerOnlyMarkTriggers (raw_sql) until the store served
  // it; the store has no SQL triggers to miss.
  // Fail-first for the marks on facts, takes and timeline entries: the Rust store marked deleted pages only, so after
  // the owner-only take, fact or timeline entry went the page derived from it read as open to every member.
  parityTest('deleting an owner-only take or fact keeps what was derived from it owner-only, and an open one marks nothing', {
    methods: ['putPage', 'addTakesBatch', 'listTakes', 'addTimelineEntry', 'getTimeline', 'insertFacts', 'recordDerivationInputs',
      'deleteTakeRows', 'deleteFactsForPage', 'readPageHiddenFromCaller'],
  }, async (engine, backend) => {
    const slugs = await seedLineage(engine, backend);
    const before = await hiddenFrom(engine, slugs);
    const origin = (await engine.getPage(ORIGIN, { sourceId: VAULT }))!.id;
    const open = (await engine.getPage(OPEN))!.id;
    await engine.deleteTakeRows(origin, [1]);
    await engine.deleteTakeRows(open, [1]);
    const deleted = [(await engine.deleteFactsForPage(ORIGIN, VAULT)).deleted, (await engine.deleteFactsForPage(OPEN, 'default')).deleted];
    const after = await hiddenFrom(engine, slugs);
    const expected = {
      'notes/marks-from-take-1': true, 'notes/marks-from-take-2': true, 'notes/marks-from-entry': true, 'notes/marks-from-fact': true,
      'notes/marks-from-open-take': false, 'notes/marks-from-open-fact': false,
    };
    expect(before).toEqual(expected);
    expect(deleted).toEqual([1, 1]);
    expect(after).toEqual(expected);
    return { before, deleted, after };
  });

  parityTest('a hard delete of an owner-only page keeps owner-only what was derived from its takes and timeline entries', {
    methods: ['putPage', 'addTakesBatch', 'listTakes', 'addTimelineEntry', 'getTimeline', 'insertFacts', 'recordDerivationInputs',
      'deletePage', 'readPageHiddenFromCaller'],
  }, async (engine, backend) => {
    const slugs = await seedLineage(engine, backend);
    const before = await hiddenFrom(engine, slugs);
    await engine.deletePage(ORIGIN, { sourceId: VAULT });
    await engine.deletePage(OPEN);
    const after = await hiddenFrom(engine, slugs);
    // The fence fact outlives its page (facts have no page key), so it still reads owner-only through its source.
    const expected = {
      'notes/marks-from-take-1': true, 'notes/marks-from-take-2': true, 'notes/marks-from-entry': true, 'notes/marks-from-fact': true,
      'notes/marks-from-open-take': false, 'notes/marks-from-open-fact': false,
    };
    expect(before).toEqual(expected);
    expect(after).toEqual(expected);
    return { before, after };
  });
});
