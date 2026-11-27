/**
 * BrainEngine parity — the fact reads and writes a forget and a proposal review make: readFactForForget,
 * expireFactSuperseded, expireFactAtDate and readWithdrawalAnchor (src/core/engine-sql/facts-trust.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readFactForForget answers a fact's source, entity, fence row number, page, expiry time and visibility
 *    (or null for an id that names nothing); expireFactSuperseded ends an active fact at the instant or the date it is
 *    given, or with none at its own earlier end or now and never before it began; expireFactAtDate ends it on a date;
 *    neither touches a fact that is already expired. readWithdrawalAnchor says whether the withdrawal ledger covers the
 *    source's fact: a source-wide withdrawal, one under the fact's entity, one whose claim differs only in case and
 *    spacing, and not one of another visibility, another entity or another source; null for a fact of another source.
 *    The answers are equal on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: a Rust brain refused all four members, so a whole forget of a fact stopped before it read the fact
 *    (docs/research/rust-cli-executeraw-map.md); an engine that reads the ledger by a different rule withdraws or keeps
 *    the wrong copies.
 *  - Why existing coverage misses it: test/engine-parity/facts-rest-sites.test.ts reads the anchor with the
 *    readFactVisibility and readFactActivity members, which Rust does not serve yet, so that case stopped before the
 *    anchor was compared, and it checks neither the entity-scoped withdrawal nor the expiry time.
 *  - Seam: none. Facts and withdrawals come from typed members. Ids differ between arms, so facts are named by text.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

async function remember(engine: BrainEngine, rows: Array<Record<string, unknown> & { fact: string }>, sourceId = SRC): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const [i, row] of rows.entries()) {
    const r = await engine.insertFact({ source: 'mcp:remember', entity_slug: null, valid_from: new Date(Date.UTC(2026, 4, 1 + i)), ...row } as never, { source_id: sourceId });
    ids.set(row.fact, r.id);
  }
  return ids;
}

describe('engine parity: the fact reads and writes a forget makes', () => {
  parityTest('readWithdrawalAnchor sees a withdrawal of the fact\'s visibility that reaches it, and nothing else', {
    methods: ['readWithdrawalAnchor', 'insertFact', 'insertFactWithdrawal'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const ids = await remember(engine, [
      { fact: 'Ana plays the cello', entity_slug: 'people/ana', visibility: 'world' },
      { fact: 'Ben plays the cello', entity_slug: 'people/ben', visibility: 'world' },
      { fact: 'Ana owns a boat', entity_slug: 'people/ana', visibility: 'world' },
      { fact: 'Ana owns a kayak', entity_slug: 'people/ana', visibility: 'private' },
      { fact: 'Cy keeps bees', entity_slug: 'people/cy', visibility: 'world' },
      { fact: 'Dee grows figs', entity_slug: null, visibility: 'world' },
      { fact: 'Eve paints', entity_slug: 'people/eve', visibility: 'world' },
    ]);
    const elsewhere = await remember(engine, [{ fact: 'Ana plays the cello', entity_slug: 'people/ana' }], 'other');
    // Entity-scoped: reaches Ana's row, not Ben's. Case and spacing differ from the stored text.
    expect(await engine.insertFactWithdrawal(SRC, 'world', '  ANA plays   the CELLO ', 'people/ana', '2026-06-01T00:00:00Z')).toBe(true);
    // Source-wide: reaches every row of the claim.
    expect(await engine.insertFactWithdrawal(SRC, 'world', 'Cy keeps bees', '*', '2026-06-01T00:00:00Z')).toBe(true);
    // Another visibility: a private row is not reached by a world withdrawal.
    expect(await engine.insertFactWithdrawal(SRC, 'world', 'Ana owns a kayak', '*', '2026-06-01T00:00:00Z')).toBe(true);
    // A withdrawal of a claim no stored row carries.
    expect(await engine.insertFactWithdrawal(SRC, 'world', 'Dee grows figs', 'people/nobody', '2026-06-01T00:00:00Z')).toBe(true);
    // A withdrawal on the fact's own entity, then the fact expires: the ledger still covers it.
    expect(await engine.insertFactWithdrawal(SRC, 'world', 'Eve paints', 'people/eve', '2026-06-01T00:00:00Z')).toBe(true);
    await engine.expireFact(ids.get('Eve paints')!);
    const ask = async (name: string, sourceId = SRC) => engine.readWithdrawalAnchor((sourceId === SRC ? ids : elsewhere).get(name)!, sourceId);
    const out = {
      entityScoped: await ask('Ana plays the cello'),
      otherEntitySameClaim: await ask('Ben plays the cello'),
      unrelated: await ask('Ana owns a boat'),
      otherVisibility: await ask('Ana owns a kayak'),
      sourceWide: await ask('Cy keeps bees'),
      unbackedOtherSubject: await ask('Dee grows figs'),
      expiredButWithdrawn: await ask('Eve paints'),
      otherSourceCopy: await ask('Ana plays the cello', 'other'),
      wrongSource: await engine.readWithdrawalAnchor(ids.get('Ana plays the cello')!, 'other'),
      missing: await engine.readWithdrawalAnchor(999_999, SRC),
      zero: await engine.readWithdrawalAnchor(0, SRC),
    };
    expect(out.entityScoped).toEqual({ withdrawn: true });
    expect(out.otherEntitySameClaim).toEqual({ withdrawn: false });
    expect(out.sourceWide).toEqual({ withdrawn: true });
    expect(out.otherVisibility).toEqual({ withdrawn: false });
    expect(out.expiredButWithdrawn).toEqual({ withdrawn: true });
    expect(out.wrongSource).toBeNull();
    expect(out.missing).toBeNull();
    return out;
  });

  parityTest('readFactForForget answers the forget columns of an expired and a fenced fact, and null for a missing one', {
    methods: ['readFactForForget', 'insertFact', 'insertFacts', 'expireFact'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const ids = await remember(engine, [
      { fact: 'a plain fact', entity_slug: 'people/a', visibility: 'world' },
      { fact: 'an expired fact', entity_slug: 'people/a', visibility: 'private' },
    ]);
    await engine.expireFact(ids.get('an expired fact')!, { at: new Date('2026-07-04T12:30:00Z') } as never);
    const fence = await engine.insertFacts([{
      fact: 'on a page', entity_slug: 'people/a', kind: 'fact', visibility: 'world', source: 'fence', row_num: 3,
      source_markdown_slug: 'notes/open', valid_from: new Date(Date.UTC(2026, 6, 1)),
    }] as never, { source_id: 'other' });
    const read = async (id: number) => {
      const r = await engine.readFactForForget(id);
      return r === null ? null : { ...r, id: Number(r.id) === id, expired_at: iso(r.expired_at), isDate: r.expired_at instanceof Date || r.expired_at === null };
    };
    const out = {
      plain: await read(ids.get('a plain fact')!),
      expired: await read(ids.get('an expired fact')!),
      fenced: await read(Number(fence.ids[0])),
      missing: await read(999_999),
      zero: await read(0),
    };
    expect(out.plain).toMatchObject({ expired_at: null, visibility: 'world', source_id: SRC });
    expect(out.expired!.expired_at).toBe('2026-07-04T12:30:00.000Z');
    expect(out.fenced).toMatchObject({ source_id: 'other', row_num: 3, source_markdown_slug: 'notes/open' });
    expect(out.missing).toBeNull();
    return out;
  });

  parityTest('expireFactSuperseded and expireFactAtDate end a fact\'s window and leave an expired fact as it was', {
    methods: ['expireFactSuperseded', 'expireFactAtDate', 'insertFact', 'expireFact', 'listFactsByEntity'],
  }, async (engine) => {
    const ids = await remember(engine, [
      { fact: 'open ended', entity_slug: 'people/a', valid_from: new Date('2026-01-01T00:00:00Z') },
      { fact: 'ends in the past', entity_slug: 'people/a', valid_from: new Date('2026-01-02T00:00:00Z'), valid_until: new Date('2026-02-01T00:00:00Z') },
      { fact: 'ends in the future', entity_slug: 'people/a', valid_from: new Date('2026-01-03T00:00:00Z'), valid_until: new Date('2099-01-01T00:00:00Z') },
      { fact: 'starts in the future', entity_slug: 'people/a', valid_from: new Date('2098-01-01T00:00:00Z') },
      { fact: 'already expired', entity_slug: 'people/a', valid_from: new Date('2026-01-04T00:00:00Z') },
      { fact: 'on a date', entity_slug: 'people/a', valid_from: new Date('2026-01-05T00:00:00Z') },
      { fact: 'missing target', entity_slug: 'people/a', valid_from: new Date('2026-01-06T00:00:00Z') },
    ]);
    await engine.expireFact(ids.get('already expired')!, { at: new Date('2026-03-03T00:00:00Z') } as never);
    for (const name of ['ends in the past', 'ends in the future', 'starts in the future']) await engine.expireFactSuperseded(ids.get(name)!, null);
    await engine.expireFactSuperseded(ids.get('already expired')!, '2026-09-09T00:00:00.500Z');
    await engine.expireFactAtDate(ids.get('on a date')!, '2026-04-05');
    await engine.expireFactSuperseded(999_999, null);
    await engine.expireFactAtDate(999_999, '2026-04-05');
    const names = new Map([...ids].map(([n, id]) => [Number(id), n]));
    const rows = await engine.listFactsByEntity(SRC, 'people/a', { activeOnly: false, limit: 100 } as never);
    const now = Date.now();
    const state = rows.map(r => {
      const until = r.valid_until == null ? null : new Date(r.valid_until as never).getTime();
      const name = names.get(Number(r.id))!;
      // "now" ends are compared by relation: Date.now() differs between the arm's clock and ours by milliseconds.
      const nowEnd = until !== null && Math.abs(until - now) < 60_000;
      return { fact: name, expired: r.expired_at != null, valid_until: nowEnd ? 'now' : iso(r.valid_until) };
    }).sort((a, b) => a.fact.localeCompare(b.fact));
    expect(state).toEqual([
      { fact: 'already expired', expired: true, valid_until: null },
      { fact: 'ends in the future', expired: true, valid_until: 'now' },
      { fact: 'ends in the past', expired: true, valid_until: '2026-02-01T00:00:00.000Z' },
      { fact: 'missing target', expired: false, valid_until: null },
      { fact: 'on a date', expired: true, valid_until: '2026-04-05T00:00:00.000Z' },
      { fact: 'open ended', expired: false, valid_until: null },
      { fact: 'starts in the future', expired: true, valid_until: '2098-01-01T00:00:00.000Z' },
    ]);
    return state;
  });
});
