/**
 * BrainEngine parity: a page derived from an owner-only fact, take or timeline row stays hidden after that row is
 * hard-deleted (GST-3032, migration v322).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: searchKeyword with `excludePrivate` hides a page of an open source whose recorded derivation input is a fact,
 *    take or timeline row of an owner-only source, and keeps it hidden after that row is hard-deleted (deletePurgedFacts,
 *    deletePurgedTakes, deleteTimelineRows): PGLite's BEFORE DELETE trigger on facts, takes and timeline_entries records
 *    the deleted row and what was derived from it in `owner_only_marks`. A page derived from an open row stays readable
 *    after that row goes. The Rust arm must answer each the same.
 *  - Regression: the Rust store wrote those marks only from a page delete, so deleting the owner-only row itself dropped
 *    the lineage and searchKeyword(excludePrivate) returned the derived page.
 *  - Why existing coverage misses it: search-privacy-retention.test.ts deletes only a page; owner-only-removal-lineage.test.ts
 *    deletes rows with raw SQL on the SQL engines only.
 *  - Seam: none (typed methods only).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { createSource, parityArms, sorted, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest, arms } = parityArms(testBackends());

const Q = 'marshwort';

interface Seeded { fact: number; take: number; timeline: { id: number; date: string; source: string; summary: string; detail: string }; vaultPageId: number; openFact: number }

/**
 * An owner-only source `vault` with one page holding a take and a timeline row, a fact of that source, and an open fact;
 * in the default source a page derived from each of the four rows, plus an underived page.
 */
async function seedBrain(engine: BrainEngine, backend: ParityBackend): Promise<Seeded> {
  await createSource(engine, backend, 'vault', { owner_only: true });
  const page = (title: string): PageInput => ({ type: 'note', title, compiled_truth: `${Q} ledger of ${title}`, timeline: '' }) as PageInput;
  const seed = (slug: string, sourceId: string) =>
    seedPage(engine, { slug, input: page(slug), chunks: [chunk(0, `${Q} ledger of ${slug}`)] }, { sourceId });
  await seed('notes/vault', 'vault');
  for (const slug of ['notes/open', 'notes/from-fact', 'notes/from-take', 'notes/from-timeline', 'notes/from-open-fact']) await seed(slug, 'default');
  const vaultPage = (await engine.getPage('notes/vault', { sourceId: 'vault' }))!;
  const fact = (await engine.insertFact({ fact: 'A vault claim', entity_slug: 'people/a', source: 'mcp:remember', valid_from: new Date('2026-05-01T00:00:00Z') } as never, { source_id: 'vault' })).id;
  const openFact = (await engine.insertFact({ fact: 'An open claim', entity_slug: 'people/a', source: 'mcp:remember', valid_from: new Date('2026-05-02T00:00:00Z') } as never, { source_id: 'default' })).id;
  await engine.addTakesBatch([{ page_id: vaultPage.id, row_num: 1, claim: 'A vault take', kind: 'fact' as const, holder: 'self' }]);
  const take = (await engine.listTakes({ page_id: vaultPage.id }))[0]!.id;
  await engine.addTimelineEntry('notes/vault', { date: '2026-05-03', source: 'chat', summary: 'A vault event', detail: '' }, { sourceId: 'vault' });
  const entry = (await engine.getTimeline('notes/vault', { sourceId: 'vault' } as never))[0]!;
  const id = async (slug: string) => String((await engine.getPage(slug, { sourceId: 'default' }))!.id);
  await engine.recordDerivationEdges({ table: 'pages', id: await id('notes/from-fact') }, 'default', [{ table: 'facts', id: String(fact) }]);
  await engine.recordDerivationEdges({ table: 'pages', id: await id('notes/from-take') }, 'default', [{ table: 'takes', id: String(take) }]);
  await engine.recordDerivationEdges({ table: 'pages', id: await id('notes/from-timeline') }, 'default', [{ table: 'timeline_entries', id: String(entry.id) }]);
  await engine.recordDerivationEdges({ table: 'pages', id: await id('notes/from-open-fact') }, 'default', [{ table: 'facts', id: String(openFact) }]);
  const date = typeof entry.date === 'string' ? entry.date.slice(0, 10) : new Date(entry.date as never).toISOString().slice(0, 10);
  return { fact, take, openFact, vaultPageId: vaultPage.id,
    timeline: { id: entry.id, date, source: entry.source, summary: entry.summary, detail: entry.detail } };
}

/** The read as a served brain makes it (the schema version the connect gate records, so the owner-only test is the function form). */
async function served(backend: string, engine: BrainEngine): Promise<string[]> {
  const own = arms().find((arm) => arm.backend === backend)!.engine;
  noteSchemaVersion(own, LATEST_SCHEMA_VERSION);
  return withEngineScope(own, async () => {
    const rows = await engine.searchKeyword(Q, { limit: 50, excludePrivate: true });
    return sorted([...new Set(rows.filter(r => r.source_id === 'default').map((r) => r.slug))]);
  });
}

const OPEN = ['notes/from-open-fact', 'notes/open'];

describe('a page derived from an owner-only row after that row is hard-deleted', () => {
  parityTest(
    'searchKeyword: pages derived from an owner-only fact, take and timeline row stay hidden after each row is deleted',
    { methods: ['searchKeyword', 'insertFact', 'addTakesBatch', 'addTimelineEntry', 'recordDerivationEdges', 'deletePurgedFacts', 'deletePurgedTakes', 'deleteTimelineRows'] },
    async (engine, backend) => {
      const s = await seedBrain(engine, backend);
      const before = await served(backend, engine);
      expect(before).toEqual(OPEN);
      const deleted = {
        fact: await engine.deletePurgedFacts([s.fact], 'vault'),
        take: await engine.deletePurgedTakes([s.take]),
        timeline: (await engine.deleteTimelineRows(s.vaultPageId, [{ ...s.timeline, removed: true }])).length,
        openFact: await engine.deletePurgedFacts([s.openFact], 'default'),
      };
      expect(deleted).toEqual({ fact: 1, take: 1, timeline: 1, openFact: 1 });
      const after = await served(backend, engine);
      expect(after).toEqual(OPEN);
      return { before, deleted, after };
    },
  );

  parityTest(
    'searchKeyword: each kind alone keeps its derived page hidden after its owner-only row is deleted',
    { methods: ['searchKeyword', 'deletePurgedFacts', 'deletePurgedTakes', 'deleteTimelineRows'] },
    async (engine, backend) => {
      const s = await seedBrain(engine, backend);
      const steps: Record<string, string[]> = {};
      await engine.deletePurgedFacts([s.fact], 'vault');
      steps.fact = await served(backend, engine);
      await engine.deletePurgedTakes([s.take]);
      steps.take = await served(backend, engine);
      await engine.deleteTimelineRows(s.vaultPageId, [{ ...s.timeline, removed: true }]);
      steps.timeline = await served(backend, engine);
      expect(steps).toEqual({ fact: OPEN, take: OPEN, timeline: OPEN });
      return steps;
    },
  );
});
