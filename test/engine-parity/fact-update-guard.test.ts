/**
 * BrainEngine parity — the withdrawal guard on fact updates (facts/withdrawal-schema.ts, the
 * `facts_preserve_withdrawal` trigger, BEFORE UPDATE OF fact, source_id, visibility, entity_slug, expired_at): an update
 * that leaves a row active that a withdrawal of its claim reaches saves it expired at the earliest such withdrawal, its
 * valid_until clamped to that time.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `placeRelinkedFact`, `linkConversationFact` and `migrateFactsToCanonical` (they set entity_slug), and
 *    `restoreSupersededFact` and `restoreFactPreimage` (they set expired_at, here to null), save a row a withdrawal
 *    reaches after the update with expired_at = valid_until = the withdrawal time. A row whose claim no withdrawal
 *    reaches stays active. The members' return values do not change.
 *  - Regression: the Rust store ran the guard only on inserts and on rehomeEntityFacts and restoreOntologyFact, so on a
 *    Rust brain these five updates left a withdrawn claim active, while PGLite and Postgres expired it.
 *  - Why existing coverage misses it: fact-relink-writes, remember-reads and the fence restore cases write no
 *    withdrawal before the update; fact-insert-guard covers inserts only.
 *  - Seam: none. Real engines, typed methods only. Ids are compared by relation, never by value.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const WITHDRAWN = '2026-03-01T10:00:00.000Z';
const person = (title: string): PageInput => ({ type: 'person', title, compiled_truth: 'body', frontmatter: {} });

/** The columns the guard writes, with the entity the update set. */
async function stamp(engine: BrainEngine, id: number) {
  const r = await engine.readPairFactRow(id);
  return {
    entity_slug: r?.entity_slug ?? null,
    expired_at: r?.expired_at ? new Date(r.expired_at as string | Date).toISOString() : null,
    valid_until: r?.valid_until ? new Date(r.valid_until as string | Date).toISOString() : null,
  };
}

/** The row a withdrawal reaches comes back expired at it, valid_until clamped; the other row stays active. */
function guarded<T extends { reached: Awaited<ReturnType<typeof stamp>>; other: Awaited<ReturnType<typeof stamp>> }>(r: T): T {
  expect([r.reached.expired_at, r.reached.valid_until]).toEqual([WITHDRAWN, WITHDRAWN]);
  expect([r.other.expired_at, r.other.valid_until]).toEqual([null, null]);
  return r;
}

async function withdraw(engine: BrainEngine, claim: string, subject: string): Promise<void> {
  expect(await engine.insertFactWithdrawal(SRC, 'world', claim, subject, WITHDRAWN)).toBe(true);
}

describe('engine parity: fact updates keep a withdrawn claim expired', () => {
  parityTest('placeRelinkedFact expires a row a withdrawal reaches on its new entity', {
    methods: ['putPage', 'insertFact', 'insertFactWithdrawal', 'placeRelinkedFact', 'readPairFactRow'],
  }, async (engine) => {
    await engine.putPage('people/alice-example', person('Alice'));
    const add = async (fact: string) => (await engine.insertFact({ fact, visibility: 'world', source: 'chat' }, { source_id: SRC })).id;
    const reached = await add('a likes tea');
    const other = await add('a likes jam');
    await withdraw(engine, 'a likes tea', 'people/alice-example');
    const placed = [];
    for (const [id, rowNum] of [[reached, 1], [other, 2]] as const) {
      placed.push(await engine.placeRelinkedFact(SRC, { factId: id, action: 'link', slug: 'people/alice-example', rowNum, context: 'relinked' }));
    }
    return guarded({ placed, reached: await stamp(engine, reached), other: await stamp(engine, other) });
  });

  parityTest('linkConversationFact expires a row a withdrawal reaches on its new entity', {
    methods: ['putPage', 'insertFacts', 'insertFactWithdrawal', 'linkConversationFact', 'readPairFactRow'],
  }, async (engine) => {
    await engine.putPage('people/alice-example', person('Alice'));
    const slug = 'conversations/2026-01-01';
    const claims = ['a met at the cafe', 'a met at the park'];
    const { ids } = await engine.insertFacts(claims.map((fact) => ({ fact, visibility: 'world', source: 'cli:extract-conversation-facts',
      row_num: null, source_markdown_slug: slug })) as never, { source_id: SRC });
    await withdraw(engine, 'a met at the cafe', 'people/alice-example');
    const linked = [];
    for (const [i, fact] of claims.entries()) {
      linked.push(await engine.linkConversationFact(SRC, { factId: ids[i]!, pageSlug: slug, fact, entitySlug: 'people/alice-example',
        context: 'relinked', from: null }));
    }
    return guarded({ linked, reached: await stamp(engine, ids[0]!), other: await stamp(engine, ids[1]!) });
  });

  parityTest('restoreSupersededFact keeps a withdrawn claim expired', {
    methods: ['insertFact', 'expireSupersededFact', 'insertFactWithdrawal', 'restoreSupersededFact', 'readPairFactRow'],
  }, async (engine) => {
    const add = async (fact: string) => (await engine.insertFact({ fact, entity_slug: 'people/a', visibility: 'world', source: 'chat' }, { source_id: SRC })).id;
    const withdrawnOld = await add('old claim');
    const keptOld = await add('kept claim');
    const newId = await add('new claim');
    for (const oldId of [withdrawnOld, keptOld]) await engine.expireSupersededFact({ oldId, sourceId: SRC, newId, until: null });
    await withdraw(engine, 'old claim', '*');
    const restored = [];
    for (const oldId of [withdrawnOld, keptOld]) {
      restored.push(await engine.restoreSupersededFact({ oldId, sourceId: SRC, expiredAt: null, validUntil: null, supersededBy: null,
        expectedSupersededBy: newId }));
    }
    return guarded({ restored, reached: await stamp(engine, withdrawnOld), other: await stamp(engine, keptOld) });
  });

  parityTest('restoreFactPreimage keeps a withdrawn claim expired', {
    methods: ['insertFacts', 'readFactPreimages', 'expireFact', 'insertFactWithdrawal', 'restoreFactPreimage', 'readPairFactRow'],
  }, async (engine) => {
    const slug = 'people/restore-example';
    const { ids } = await engine.insertFacts(['Alpha', 'Beta'].map((fact, i) => ({ fact, entity_slug: slug, source: 'fence',
      source_markdown_slug: slug, kind: 'fact', visibility: 'world', row_num: i + 1 })) as never, { source_id: SRC });
    const pre = await engine.readFactPreimages(SRC, ids);
    for (const id of ids) await engine.expireFact(id, {});
    await withdraw(engine, 'Alpha', '*');
    const restored = [];
    for (const p of pre) restored.push(await engine.restoreFactPreimage(SRC, p as unknown as Record<string, unknown>));
    return guarded({ restored, reached: await stamp(engine, ids[0]!), other: await stamp(engine, ids[1]!) });
  });

  parityTest('migrateFactsToCanonical expires a row a withdrawal reaches on the canonical entity', {
    methods: ['putPage', 'insertFacts', 'insertFactWithdrawal', 'migrateFactsToCanonical', 'readPairFactRow'],
  }, async (engine) => {
    await engine.putPage('people/bob-example', person('Bob'));
    const { ids } = await engine.insertFacts(['b likes chess', 'b likes go'].map((fact, i) => ({ fact, entity_slug: 'people/bob',
      source: 'fence', source_markdown_slug: 'people/bob', kind: 'fact', visibility: 'world', row_num: i + 1 })) as never, { source_id: SRC });
    await withdraw(engine, 'b likes chess', 'people/bob-example');
    const moved = await engine.migrateFactsToCanonical('people/bob', 'people/bob-example', SRC);
    return guarded({ moved, reached: await stamp(engine, ids[0]!), other: await stamp(engine, ids[1]!) });
  });
});
