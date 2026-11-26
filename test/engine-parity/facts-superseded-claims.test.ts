/**
 * BrainEngine parity — the read behind `gbrain query`'s superseded-claim stamp (search/facts-arm.ts
 * stampSupersededClaims), BrainEngine.listTypedClaimFactsAtPages.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the member returns the typed-claim facts held on the named pages about the named entities on every engine
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1), equal row for row.
 *  - Regression: the read was raw SQL inside `.catch(() => undefined)`, so on a Rust brain every query that matched
 *    typed claims quietly lost its `superseded_claim` stamps.
 *  - Why existing coverage misses it: the facts-arm tests run on PGLite only, and no parity case drove a query
 *    whose matched facts carried typed claims.
 *  - Seam: none. Real engines and the typed member. The end-to-end `gbrain query` case lives with the facts arm's other
 *    raw reads (facts-arm.ts readableEntityPages, evidence-date.ts factObservationDates): until both are typed, a Rust
 *    query that stamps a claim still swallows their refusals.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());
const ENTITY = 'people/alice-example';
const OLD_PAGE = 'meetings/2025-06-01-harbor';
const NEW_PAGE = 'notes/harbor-revenue';

async function withHome<T>(run: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-superseded-'));
  try { return await withEnv({ GBRAIN_HOME: home }, run); } finally { rmSync(home, { recursive: true, force: true }); }
}

/** An entity page and two pages, each holding one typed revenue claim about the entity for 2025; the second is newer. */
async function fixture(engine: BrainEngine): Promise<{ older: number; newer: number }> {
  const body = 'Alice reported the harbor ledger revenue for 2025.';
  await seedPage(engine, { slug: ENTITY, input: { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example runs the harbor ledger.', timeline: '' }, chunks: [chunk(0, 'Alice Example runs the harbor ledger.')] });
  await seedPage(engine, { slug: OLD_PAGE, input: { type: 'meeting', title: 'Harbor revenue review', compiled_truth: body, timeline: '' }, chunks: [chunk(0, body)] });
  await seedPage(engine, { slug: NEW_PAGE, input: { type: 'note', title: 'Harbor revenue update', compiled_truth: body, timeline: '' }, chunks: [chunk(0, body)] });
  const claim = (fact: string, page: string, when: string) => ({
    fact, entity_slug: ENTITY, source_markdown_slug: page, row_num: 1, kind: 'fact', visibility: 'world', source: 'fence',
    claim_metric: 'revenue', claim_value: fact.includes('20') ? 20 : 10, claim_unit: 'usd', claim_period: '2025', valid_from: new Date(when),
  });
  const older = await engine.insertFacts([claim('Alice harbor ledger revenue was 10 in 2025.', OLD_PAGE, '2025-06-01T00:00:00Z')] as never, { source_id: 'default' });
  const newer = await engine.insertFacts([claim('Alice harbor ledger revenue was 20 in 2025.', NEW_PAGE, '2025-09-01T00:00:00Z')] as never, { source_id: 'default' });
  return { older: older.ids[0]!, newer: newer.ids[0]! };
}

describe('engine parity: the typed-claim facts behind the superseded-claim stamp', () => {
  parityTest('listTypedClaimFactsAtPages returns the claim facts of the named pages and entities',
    { methods: ['insertFacts', 'listTypedClaimFactsAtPages'], timeout: 120_000 }, async (engine) => withHome(async () => {
      const ids = await fixture(engine);
      const view = async (pages: string[], entities: string[]) => sorted((await engine.listTypedClaimFactsAtPages(pages, entities)).map(r => ({
        fact: Number(r.id) === ids.older ? 'older' : Number(r.id) === ids.newer ? 'newer' : 'other', source_id: r.source_id, page: r.source_markdown_slug,
        entity: r.entity_slug, metric: r.claim_metric, period: r.claim_period, valid_from: new Date(r.valid_from).toISOString() })), r => r.fact);
      const out = {
        both: await view([OLD_PAGE, NEW_PAGE], [ENTITY]),
        onePage: await view([OLD_PAGE], [ENTITY]),
        otherEntity: await view([OLD_PAGE, NEW_PAGE], ['people/bob-example']),
        noPages: await view([], [ENTITY]),
      };
      expect(out.both.map(r => r.fact)).toEqual(['newer', 'older']);
      expect(out.onePage).toEqual([{ fact: 'older', source_id: 'default', page: OLD_PAGE, entity: ENTITY, metric: 'revenue', period: '2025', valid_from: '2025-06-01T00:00:00.000Z' }]);
      expect({ otherEntity: out.otherEntity, noPages: out.noPages }).toEqual({ otherEntity: [], noPages: [] });
      return out;
    }));
});
