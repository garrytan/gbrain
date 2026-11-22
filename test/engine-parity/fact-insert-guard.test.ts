/**
 * BrainEngine parity — the withdrawal half of the facts insert guard (facts/insert-guard-schema.ts
 * `gbrain_guard_inserted_facts`, with the per-row `facts_preserve_withdrawal_insert` trigger of
 * facts/withdrawal-schema.ts): an inserted active fact that a withdrawal of its claim reaches is saved expired at the
 * earliest such withdrawal, its valid_until clamped to that time.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `insertFact` and `insertFacts` save a fact that a withdrawal at its source and visibility reaches with
 *    expired_at = the earliest reaching withdrawn_at and valid_until = LEAST(valid_until, that time). A withdrawal
 *    reaches a row on a member page (memory/members/...) only when its subject is that page; any other row when its
 *    subject is '*' or the row's entity, or, for a row on an unbacked name key, any subject but an owned memory page.
 *    A row inserted already expired (insertFacts) keeps its expiry. The insert status, ids, warnings and counts do not change.
 *  - Regression: the Rust store ran the purge half of the guard on insert but not the withdrawal stamp, so on a Rust
 *    brain a forgotten claim saved again came back active, while PGLite and Postgres saved it expired.
 *  - Why existing coverage misses it: the withdrawal cases of test/engine-parity read withdrawals or repair rows that
 *    exist; none inserts a fact after its claim was withdrawn and reads the row back.
 *  - Seam: none. Real engines, typed methods only. Ids are compared by relation, never by value.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, FactRow, NewFact } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-02T10:00:00.000Z';
const LATER = new Date('2027-01-01T00:00:00.000Z');
const EARLIER = new Date('2026-02-01T00:00:00.000Z');
const MEMBER = 'memory/members/ana-example';

/** The columns the guard writes, per fact, sorted by claim then entity. */
async function readBack(engine: BrainEngine, entities: readonly string[]) {
  const rows: FactRow[] = [];
  for (const entity of entities) rows.push(...await engine.listFactsByEntity(SRC, entity, { activeOnly: false }));
  return rows
    .map((r) => ({
      fact: r.fact,
      entity_slug: r.entity_slug,
      expired_at: r.expired_at ? new Date(r.expired_at).toISOString() : null,
      valid_until: r.valid_until ? new Date(r.valid_until).toISOString() : null,
    }))
    .sort((a, b) => (a.fact + '\0' + a.entity_slug < b.fact + '\0' + b.entity_slug ? -1 : 1));
}

async function withdraw(engine: BrainEngine, claim: string, subject: string, at: string): Promise<void> {
  expect(await engine.insertFactWithdrawal(SRC, 'private', claim, subject, at)).toBe(true);
}

describe('engine parity: the insert guard stamps a withdrawn claim', () => {
  parityTest('insertFact saves a fact a withdrawal reaches expired at the earliest one, valid_until clamped', {
    methods: ['insertFactWithdrawal', 'insertFact', 'listFactsByEntity'],
  }, async (engine) => {
    await withdraw(engine, 'Alice moved to Paris', '*', T2);
    await withdraw(engine, 'Alice moved to Paris', 'people/a', T1);
    await withdraw(engine, 'Bob plays chess', 'people/a', T1);
    await withdraw(engine, 'Carol sings', 'memory/scope', T1);
    const insert = async (fact: string, entity: string, extra: Partial<NewFact> = {}) => {
      const out = await engine.insertFact({
        fact, entity_slug: entity, visibility: 'private', source: 'mcp:remember', embedding: null,
        valid_from: new Date(T0), ...extra,
      } as NewFact, { source_id: SRC });
      return out.status;
    };
    const statuses = [
      // Reached by both; the earliest (the entity's, T1) wins and clamps a later valid_until.
      await insert('Alice moved to Paris', 'people/a', { valid_until: LATER }),
      // Reached by '*' only (T2); a valid_until before T2 stays.
      await insert('Alice moved to Paris', 'people/c', { valid_until: EARLIER }),
      // Another visibility: not reached.
      await insert('Alice moved to Paris', 'people/e', { visibility: 'world' }),
      // A backed entity the subject does not name: not reached.
      await insert('Bob plays chess', 'people/b'),
      // An unbacked name key: reached by a withdrawal under any subject...
      await insert('Bob plays chess', 'bob'),
      // ...but not by one on an owned memory page.
      await insert('Carol sings', 'carol'),
    ];
    const rows = await readBack(engine, ['people/a', 'people/b', 'people/c', 'people/e', 'bob', 'carol']);
    expect(rows).toEqual([
      { fact: 'Alice moved to Paris', entity_slug: 'people/a', expired_at: T1, valid_until: T1 },
      { fact: 'Alice moved to Paris', entity_slug: 'people/c', expired_at: T2, valid_until: EARLIER.toISOString() },
      { fact: 'Alice moved to Paris', entity_slug: 'people/e', expired_at: null, valid_until: null },
      { fact: 'Bob plays chess', entity_slug: 'bob', expired_at: T1, valid_until: T1 },
      { fact: 'Bob plays chess', entity_slug: 'people/b', expired_at: null, valid_until: null },
      { fact: 'Carol sings', entity_slug: 'carol', expired_at: null, valid_until: null },
    ]);
    return { statuses, rows };
  });

  parityTest('insertFacts stamps each withdrawn fence row and a member page row only by its own page', {
    methods: ['insertFactWithdrawal', 'insertFacts', 'listFactsByEntity'],
  }, async (engine) => {
    await withdraw(engine, 'Dana joined Acme', '*', T1);
    await withdraw(engine, 'Erin left Acme', MEMBER, T2);
    await withdraw(engine, 'Finn likes tea', '*', T1);
    const row = (fact: string, entity: string, slug: string, n: number, extra: Record<string, unknown> = {}) => ({
      fact, entity_slug: entity, kind: 'fact', visibility: 'private', source: 'fence', embedding: null,
      valid_from: new Date(T0), row_num: n, source_markdown_slug: slug, ...extra,
    });
    const out = await engine.insertFacts([
      row('Dana joined Acme', 'people/dana', 'notes/guard', 1),
      row('Gus joined Acme', 'people/gus', 'notes/guard', 2),
      // Already expired: kept as written.
      row('Dana joined Acme', 'people/hal', 'notes/guard', 3, { expired_at: new Date(T0) }),
      // A member page row: its own page's withdrawal reaches it...
      row('Erin left Acme', 'people/erin', MEMBER, 1),
      // ...a subject-'*' withdrawal does not.
      row('Finn likes tea', 'people/finn', MEMBER, 2),
    ] as never, { source_id: SRC });
    const rows = await readBack(engine, ['people/dana', 'people/gus', 'people/hal', 'people/erin', 'people/finn']);
    expect(rows).toEqual([
      { fact: 'Dana joined Acme', entity_slug: 'people/dana', expired_at: T1, valid_until: T1 },
      { fact: 'Dana joined Acme', entity_slug: 'people/hal', expired_at: T0, valid_until: null },
      { fact: 'Erin left Acme', entity_slug: 'people/erin', expired_at: T2, valid_until: T2 },
      { fact: 'Finn likes tea', entity_slug: 'people/finn', expired_at: null, valid_until: null },
      { fact: 'Gus joined Acme', entity_slug: 'people/gus', expired_at: null, valid_until: null },
    ]);
    return { inserted: out.inserted, ids: out.ids.length, warnings: out.warnings, deleted: out.deleted, rows };
  });
});
