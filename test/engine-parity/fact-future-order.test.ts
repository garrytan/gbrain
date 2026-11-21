/**
 * BrainEngine parity — newest-first fact reads rank a fact dated in the future as of when it was written.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listFactsByEntity and the entity arm of listFactsForRelevance order a named entity's facts by
 *    `valid_from`, except that a fact whose `valid_from` is after now ranks by its `created_at`, then `id`, newest
 *    first. A fact dated decades ahead no longer holds the top of the list over a fact written after it.
 *  - Regression: master's GST-3170 changed the SQL of both reads; the Rust store kept ordering by `valid_from`, so a
 *    Rust brain put the far-future fact first.
 *  - Why existing coverage misses it: test/facts-future-valid-from-gst3170.test.ts runs PGLite and Postgres only, and
 *    the parity reads of these methods seed no future-dated fact.
 *  - Seam: none. Real engines, typed methods only. The later fact is written a few milliseconds after the
 *    future-dated one, so its `valid_from` is after the future fact's `created_at` on every engine's clock.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const ENTITY = 'people/alice-example';

async function add(engine: BrainEngine, fact: string, validFrom: Date): Promise<void> {
  await engine.insertFact({ fact, entity_slug: ENTITY, source: 'test', visibility: 'world', valid_from: validFrom }, { source_id: 'default' });
}

describe('engine parity: a future-dated fact ranks as of when it was written', () => {
  parityTest('listFactsByEntity and the relevance entity arm put a fact written later above a far-future fact', {
    methods: ['insertFact', 'listFactsByEntity', 'listFactsForRelevance'],
  }, async (engine) => {
    await add(engine, 'old fact', new Date('2020-01-01T00:00:00Z'));
    await add(engine, 'far future fact', new Date('2099-01-01T00:00:00Z'));
    await new Promise(resolve => setTimeout(resolve, 50));
    await add(engine, 'later fact', new Date());
    const byEntity = (await engine.listFactsByEntity('default', ENTITY, { limit: 10 })).map(f => f.fact);
    const firstTwo = (await engine.listFactsByEntity('default', ENTITY, { limit: 2 })).map(f => f.fact);
    const relevance = (await engine.listFactsForRelevance({
      arm: 'entity', scope: { sourceIds: ['default'], worldOnly: false, excludePrivate: false }, vector: null, entity: { sourceId: 'default', slug: ENTITY }, limit: 10,
    })).map(r => r.fact);
    const order = ['later fact', 'far future fact', 'old fact'];
    expect(byEntity).toEqual(order);
    expect(firstTwo).toEqual(order.slice(0, 2));
    expect(relevance).toEqual(order);
    return { byEntity, firstTwo, relevance };
  });
});
