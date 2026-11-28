/**
 * BrainEngine parity — `gbrain query`'s fact rows end to end, and the observed-date read under them
 * (search/evidence-date.ts factObservationDates, through BrainEngine.listFactHoldingRefs and
 * BrainEngine.readAdmittedPageDateFields).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a query that matches two typed claims of one slot returns the same page rows (the older claim's page
 *    stamped `superseded_claim` with the newer claim) and the same fact rows (each naming its readable entity page)
 *    on every engine. The observed date of each fact is its holding page's observation date (the date in its slug or
 *    its frontmatter), under the caller's page read policy, equal on every engine.
 *  - Regression: the facts arm read the observed dates with raw SQL inside a catch that turned any error, a refusal
 *    included, into a quiet degraded marker, so a Rust brain's fact rows lost their observed dates.
 *  - Why existing coverage misses it: the facts-arm and evidence-date tests run on PGLite only.
 *  - Seam: none. Real engines, the query op handler under the CLI's local caller, and the typed members.
 *  - No pin: the facts arm's other two reads (stampSupersededClaims, readableEntityPages) are typed on main, so the
 *    query case is compared value for value on Rust.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { factObservationDates } from '../../src/core/search/evidence-date.ts';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ENTITY = 'people/alice-example';
const OLD_PAGE = 'meetings/2025-06-01-harbor';
const NEW_PAGE = 'notes/harbor-revenue';

async function withHome<T>(run: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-facts-arm-'));
  try { return await withEnv({ GBRAIN_HOME: home }, run); } finally { rmSync(home, { recursive: true, force: true }); }
}

/** An entity page and two pages, each holding one typed revenue claim about the entity for 2025; the second is newer. */
async function fixture(engine: BrainEngine): Promise<{ older: number; newer: number }> {
  const body = 'Alice reported the harbor ledger revenue for 2025.';
  await seedPage(engine, { slug: ENTITY, input: { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example runs the harbor ledger.', timeline: '' }, chunks: [chunk(0, 'Alice Example runs the harbor ledger.')] });
  await seedPage(engine, { slug: OLD_PAGE, input: { type: 'meeting', title: 'Harbor revenue review', compiled_truth: body, timeline: '' }, chunks: [chunk(0, body)] });
  await seedPage(engine, { slug: NEW_PAGE, input: { type: 'note', title: 'Harbor revenue update', compiled_truth: body, timeline: '', frontmatter: { date: '2025-09-02' } }, chunks: [chunk(0, body)] });
  const claim = (fact: string, page: string, when: string) => ({
    fact, entity_slug: ENTITY, source_markdown_slug: page, row_num: 1, kind: 'fact', visibility: 'world', source: 'fence',
    claim_metric: 'revenue', claim_value: fact.includes('20') ? 20 : 10, claim_unit: 'usd', claim_period: '2025', valid_from: new Date(when),
  });
  const older = await engine.insertFacts([claim('Alice harbor ledger revenue was 10 in 2025.', OLD_PAGE, '2025-06-01T00:00:00Z')] as never, { source_id: 'default' });
  const newer = await engine.insertFacts([claim('Alice harbor ledger revenue was 20 in 2025.', NEW_PAGE, '2025-09-01T00:00:00Z')] as never, { source_id: 'default' });
  return { older: older.ids[0]!, newer: newer.ids[0]! };
}

type Row = { slug?: string; result_type?: string; fact_id?: string; page_slug?: string; chunk_text?: string; superseded_claim?: { fact_id: number; valid_from: string } };

describe('engine parity: the facts arm of gbrain query, end to end', () => {
  parityTest('a query that matches two claims of one slot: stamped page rows and fact rows that name their entity page',
    { methods: ['insertFacts'], timeout: 120_000 },
    async (engine) => withHome(async () => {
      const ids = await fixture(engine);
      const name = (id: unknown) => Number(id) === ids.older ? 'older' : Number(id) === ids.newer ? 'newer' : 'other';
      const ctx = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
      const out = await operationsByName.query!.handler(ctx, { query: 'Alice harbor ledger revenue 2025' }) as { results?: unknown[] } | unknown[];
      const rows = (Array.isArray(out) ? out : out.results ?? []) as Row[];
      const pages = sorted(rows.filter(r => r.result_type !== 'fact' && (r.slug === OLD_PAGE || r.slug === NEW_PAGE)).map(r => ({
        slug: r.slug, stamp: r.superseded_claim ? { fact: name(r.superseded_claim.fact_id), valid_from: r.superseded_claim.valid_from } : null })), r => r.slug!);
      const facts = sorted(rows.filter(r => r.result_type === 'fact').map(r => ({ fact: name(r.fact_id), page_slug: r.page_slug ?? null, text: r.chunk_text })), r => r.fact);
      // Every engine, Rust included, gives the full answer; the harness also compares Rust value for value with PGLite.
      expect(pages).toEqual([
        { slug: OLD_PAGE, stamp: { fact: 'newer', valid_from: '2025-09-01T00:00:00.000Z' } },
        { slug: NEW_PAGE, stamp: null },
      ].sort((a, b) => (a.slug < b.slug ? -1 : 1)));
      expect(facts.map(f => [f.fact, f.page_slug])).toEqual([['newer', ENTITY], ['older', ENTITY]]);
      return { pages, facts };
    }));

  parityTest('factObservationDates dates each fact from its holding page, with or without the carried slug',
    { methods: ['insertFacts', 'listFactHoldingRefs', 'readAdmittedPageDateFields'], timeout: 120_000 }, async (engine) => withHome(async () => {
      const ids = await fixture(engine);
      const view = (dates: Map<number, string>) => sorted([...dates].map(([id, day]) => ({ fact: id === ids.older ? 'older' : id === ids.newer ? 'newer' : 'other', day })), r => r.fact);
      const carried = [
        { id: ids.older, entity_slug: ENTITY, source_id: 'default', source_markdown_slug: OLD_PAGE },
        { id: ids.newer, entity_slug: ENTITY, source_id: 'default', source_markdown_slug: NEW_PAGE },
      ];
      const out = {
        carried: view(await factObservationDates(engine, carried, null, undefined)),
        // Rows without their holding slug are looked up by id (listFactHoldingRefs).
        looked_up: view(await factObservationDates(engine, [{ id: ids.older }, { id: ids.newer }], null, undefined)),
        scoped: view(await factObservationDates(engine, carried, null, { sourceIds: ['default'] })),
        other_source: view(await factObservationDates(engine, carried, null, { sourceIds: ['nowhere'] })),
      };
      expect(out.carried).toEqual([{ fact: 'newer', day: '2025-09-02' }, { fact: 'older', day: '2025-06-01' }]);
      expect(out.looked_up).toEqual(out.carried);
      expect(out.scoped).toEqual(out.carried);
      expect(out.other_source).toEqual([]);
      return out;
    }));

  parityTest('listFactHoldingRefs and readAdmittedPageDateFields return the facts\' refs and the admitted pages\' date fields',
    { methods: ['insertFacts', 'listFactHoldingRefs', 'readAdmittedPageDateFields'], timeout: 120_000 }, async (engine) => withHome(async () => {
      const ids = await fixture(engine);
      const refs = sorted((await engine.listFactHoldingRefs([ids.newer, ids.older, 999_999])).map(r => ({
        fact: Number(r.id) === ids.older ? 'older' : 'newer', source_id: r.source_id, slug: r.slug, entity_slug: r.entity_slug })), r => r.fact);
      const fields = async (policy: { sourceIds?: string[] }) => sorted((await engine.readAdmittedPageDateFields(
        [{ source_id: 'default', slug: OLD_PAGE }, { source_id: 'default', slug: NEW_PAGE }, { source_id: 'default', slug: 'notes/missing' }], policy)).map(r => ({
        slug: r.slug, source_id: r.source_id, date: (typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : r.frontmatter as Record<string, unknown>)?.date ?? null,
        import_filename: r.import_filename ?? null })), r => r.slug);
      const out = { refs, all: await fields({}), elsewhere: await fields({ sourceIds: ['nowhere'] }), none: await engine.readAdmittedPageDateFields([], {}) };
      expect(out.refs).toEqual([
        { fact: 'newer', source_id: 'default', slug: NEW_PAGE, entity_slug: ENTITY },
        { fact: 'older', source_id: 'default', slug: OLD_PAGE, entity_slug: ENTITY },
      ]);
      expect(out.all.map(r => [r.slug, r.date])).toEqual([[OLD_PAGE, null], [NEW_PAGE, '2025-09-02']]);
      expect({ elsewhere: out.elsewhere, none: out.none }).toEqual({ elsewhere: [], none: [] });
      return out;
    }));
});
