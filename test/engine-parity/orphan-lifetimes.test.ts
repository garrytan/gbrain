/**
 * BrainEngine parity: the belief ledger's orphan lifetime check (`orphanLifetimes`, src/core/belief/coverage-report.ts),
 * which `gbrain beliefs` status, the cycle and `doctor --tier deep` read.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1) the check finds the open
 *    lifetimes of the source's current incarnation whose slug has no page (`no_page`), and, with `deep`, the lifetimes the
 *    source's events name that no lifetime holds (`no_lifetime`); it skips an ended lifetime, a lifetime whose page
 *    exists and another source's lifetime; it samples by slug then lifetime bytes, at most `limit`, and counts them all.
 *  - Regression: the check read the lifetimes, the pages and the events through raw SQL, so on a Rust brain it stopped
 *    on the raw_sql refusal and the ledger health report could not say whether any lifetime was orphaned.
 *  - Why existing coverage misses it: test/engine-parity/collate-belief-cycle-walks.test.ts deletes page rows with raw
 *    SQL to make its orphans, so its Rust arm stops before the check runs.
 *  - Seam: none. Lifetimes are minted with mintBeliefLifetime and events written with insertBeliefEvents, the members the
 *    ledger writes through; a lifetime minted for a slug with no page is the untracked hard delete the check looks for.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { BeliefEventInsertRow } from '../../src/core/engine-sql/belief-ledger.ts';
import { orphanLifetimes } from '../../src/core/belief/coverage-report.ts';

const { parityTest } = parityArms(testBackends());

const L = (n: number) => `00000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
const PUB = '00000000-0000-4000-8000-0000000000f1';

function event(incarnation: string, key: string, lifetime: string, slug: string): BeliefEventInsertRow {
  return {
    event_key: key, source_id: 'default', source_incarnation: incarnation, page_lifetime: lifetime, slug, subject_kind: 'fact',
    subject_key: `fact:${key}`, event_type: 'fact.asserted', origin: 'live', trust_tier: 'owner', writer_tier: null, tier_basis: 'row',
    visibility: 'world', publication_id: PUB, ord: Number.parseInt(key, 16), source_time: '2026-03-01T10:00:00.000Z', valid_from: null,
    valid_until: null, value: JSON.stringify({ claim: `claim ${key}` }), value_hash: `vh${key}`, prior_hash: null, state_hash: `sh${key}`,
    cause: JSON.stringify({ kind: 'test' }), claim_fp: `fp${key}`, purged: false, redacted_fields: null,
  };
}

describe('engine parity: the orphan lifetime check', () => {
  parityTest('orphanLifetimes finds open lifetimes with no page, and deep finds events naming no lifetime, sampled by bytes', {
    methods: ['listOrphanLifetimes', 'mintBeliefLifetime', 'endBeliefLifetime', 'insertBeliefEvents'],
    timeout: 90_000,
  }, async (engine: BrainEngine, backend) => {
    await createSource(engine, backend, 'other-example');
    const inc = (await engine.readLedgerSource('default'))!.incarnation;
    const otherInc = (await engine.readLedgerSource('other-example'))!.incarnation;
    const page = await engine.putPage('notes/kept', { type: 'note' as never, title: 'Kept', compiled_truth: 'Kept.', timeline: '' });
    const mint = (lifetime: string, slug: string, sourceId = 'default', incarnation = inc) =>
      engine.mintBeliefLifetime({ lifetime, sourceId, incarnation, slug, pageId: Number(page.id) });
    await mint(L(1), 'notes/kept');
    await mint(L(2), 'notes/b-gone');
    await mint(L(3), 'notes/a-gone');
    await mint(L(4), 'notes/a/gone');
    await mint(L(5), 'notes/ended');
    await engine.endBeliefLifetime(L(5));
    await mint(L(6), 'notes/other', 'other-example', otherInc);
    await engine.insertBeliefEvents([event(inc, '0a', L(1), 'notes/kept'), event(inc, '0b', L(9), 'notes/lost')]);
    const view = (r: Awaited<ReturnType<typeof orphanLifetimes>>) => ({ count: r.count, samples: r.samples.map(s => `${s.slug} ${s.page_lifetime} ${s.reason}`) });
    const answers = {
      routine: view(await orphanLifetimes(engine, 'default', 20)),
      capped: view(await orphanLifetimes(engine, 'default', 2)),
      deep: view(await orphanLifetimes(engine, 'default', 20, { deep: true })),
      other: view(await orphanLifetimes(engine, 'other-example', 20)),
    };
    expect(answers).toEqual({
      routine: { count: 3, samples: [`notes/a-gone ${L(3)} no_page`, `notes/a/gone ${L(4)} no_page`, `notes/b-gone ${L(2)} no_page`] },
      capped: { count: 3, samples: [`notes/a-gone ${L(3)} no_page`, `notes/a/gone ${L(4)} no_page`] },
      deep: { count: 4, samples: [`notes/a-gone ${L(3)} no_page`, `notes/a/gone ${L(4)} no_page`, `notes/b-gone ${L(2)} no_page`, `notes/lost ${L(9)} no_lifetime`] },
      other: { count: 1, samples: [`notes/other ${L(6)} no_page`] },
    });
    return answers;
  });
});
