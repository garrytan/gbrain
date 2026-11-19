/**
 * BrainEngine parity — the reads a forget makes to decide whether its withdrawal reaches other copies of the claim, and
 * whether the brain owner's own credential reaches the fact (src/core/persistence/forget-prepare.ts), which ran through
 * `executeRaw` before they had members (src/core/engine-sql/memory-mutation-reads.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: isFactEntityUnbacked says whether a fact's entity is a name key with no live page (no `/`, no live page
 *    of that slug in the source); readLinkedFactCopies answers the other active facts of the same source and visibility
 *    whose claim has the same fingerprint and that name another, non-null entity, ordered by id, at most five, only
 *    world ones with worldOnly and under the remote floor with remoteFloor; hasHiddenFactCopy says whether an active
 *    copy of the claim that the withdrawal reaches (any entity for an unlinked or unbacked fact, else the same entity)
 *    fails the remote floor; ownerReachesFact says whether the fact sits on no owned memory page and every page of its
 *    source and entity slugs passes the owner's read rule and read policy (an owner with no member identity reads no page).
 *  - Regression: `gbrain forget` refuses a withdrawal that would silently reach entity-linked copies (claim_linked) and,
 *    for a remote caller, one that would reach a copy it cannot see; an engine that drops a clause withdraws facts the
 *    caller never named, or refuses a forget nothing else shares.
 *  - Why existing coverage misses it: the reads were raw SQL inside forget-prepare.ts, so no engine arm ran them.
 *  - Seam: none. Sources come from the harness fixture, rows from typed members. Ids differ between arms, so facts are
 *    named by their text and an answered id is compared only as the name it maps to.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

const note = (title: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title, compiled_truth: 'x', timeline: '', frontmatter });

/** Insert one fact in a transaction whose write trust settings declare the operator tier; its id. */
async function insert(engine: BrainEngine, row: { fact: string; entity: string | null; page: string | null; visibility?: 'world' | 'private'; validUntil?: Date; sourceId?: string }, n: number): Promise<number> {
  const out = await engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'],
      ['operator_curated', 'operator_curated', JSON.stringify({ channel: 'operator_curated' })]);
    return tx.insertFacts([{
      fact: row.fact, entity_slug: row.entity, source_markdown_slug: row.page, row_num: n, kind: 'fact',
      visibility: row.visibility ?? 'world', source: 'fence', valid_from: new Date(Date.UTC(2026, 6, 1)),
      ...(row.validUntil ? { valid_until: row.validUntil } : {}),
    }] as never, { source_id: row.sourceId ?? 'default' });
  });
  return Number(out.ids[0]!);
}

describe('engine parity: forget reach reads', () => {
  parityTest('isFactEntityUnbacked, readLinkedFactCopies and hasHiddenFactCopy read the copies a forget also withdraws',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFacts', 'expireFact', 'isFactEntityUnbacked', 'readLinkedFactCopies', 'hasHiddenFactCopy'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await engine.putPage('people/e-example', note('E'));
      await engine.putPage('notes/open', note('Open'));
      await engine.putPage('notes/private', note('Private', { visibility: 'private' }));
      await engine.putPage('notes/readers', note('Readers', { readable_by: ['member:alice-example'] }));
      const past = new Date(Date.UTC(2020, 0, 1));
      const rows: Array<{ name: string; fact: string; entity: string | null; page: string | null; visibility?: 'world' | 'private'; validUntil?: Date; sourceId?: string }> = [
        { name: 'a-unlinked', fact: 'Alice keeps bees', entity: null, page: 'notes/open' },
        { name: 'a-e', fact: '  ALICE keeps   bees ', entity: 'people/e-example', page: 'notes/open' },
        { name: 'a-f-private-page', fact: 'Alice keeps bees', entity: 'people/f-example', page: 'notes/private' },
        { name: 'a-g-private', fact: 'Alice keeps bees', entity: 'people/g-example', page: 'notes/open', visibility: 'private' },
        { name: 'a-h-expired', fact: 'Alice keeps bees', entity: 'people/h-example', page: 'notes/open' },
        { name: 'a-i-ended', fact: 'Alice keeps bees', entity: 'people/i-example', page: 'notes/open', validUntil: past },
        { name: 'a-other-source', fact: 'Alice keeps bees', entity: 'people/e-example', page: null, sourceId: 'other' },
        { name: 'b-unbacked', fact: 'Bob bakes bread', entity: 'bobname', page: 'notes/open' },
        { name: 'b-e', fact: 'Bob bakes bread', entity: 'people/e-example', page: 'notes/open' },
        { name: 'b-readers', fact: 'Bob bakes bread', entity: 'people/r-example', page: 'notes/readers' },
        { name: 'c-backed', fact: 'Carol sails', entity: 'people/e-example', page: 'notes/open' },
        { name: 'c-same-readers', fact: 'Carol sails', entity: 'people/e-example', page: 'notes/readers' },
        { name: 'c-other-private', fact: 'Carol sails', entity: 'people/z-example', page: 'notes/private' },
        { name: 'k-backed', fact: 'Kim knits', entity: 'people/e-example', page: 'notes/open' },
        { name: 'k-other-private', fact: 'Kim knits', entity: 'people/z-example', page: 'notes/private' },
        { name: 'p-unlinked', fact: 'Pat paints', entity: null, page: 'notes/open', visibility: 'private' },
        { name: 'p-e', fact: 'Pat paints', entity: 'people/e-example', page: 'notes/open', visibility: 'private' },
        { name: 'p-world', fact: 'Pat paints', entity: 'people/w-example', page: 'notes/open' },
        { name: 'd-unlinked', fact: 'Dana runs', entity: null, page: null },
        ...[1, 2, 3, 4, 5, 6, 7].map(i => ({ name: `d-${i}`, fact: 'Dana runs', entity: `people/d${i}-example`, page: 'notes/open' })),
      ];
      const ids = new Map<string, number>();
      for (const [i, r] of rows.entries()) ids.set(r.name, await insert(engine, r, i + 1));
      expect(await engine.expireFact(ids.get('a-h-expired')!, { at: new Date(Date.UTC(2026, 8, 1)) })).toBe(true);
      const nameOf = new Map([...ids].map(([name, id]) => [id, name]));
      const linked = async (name: string, spec: { worldOnly?: boolean; remoteFloor?: boolean; sourceId?: string } = {}) =>
        (await engine.readLinkedFactCopies({ id: ids.get(name)!, sourceId: spec.sourceId ?? 'default', worldOnly: spec.worldOnly ?? false, remoteFloor: spec.remoteFloor ?? false }))
          .map(row => `${nameOf.get(Number(row.id))} ${row.entity_slug}`);
      const targets = ['a-unlinked', 'b-unbacked', 'c-backed', 'k-backed', 'p-unlinked', 'd-unlinked', 'a-e'];
      const each = async <T,>(fn: (name: string) => Promise<T>) => {
        const out: Record<string, T> = {};
        for (const name of targets) out[name] = await fn(name);
        return out;
      };
      const unknown = Math.max(...ids.values()) + 1000;
      const out = {
        unbacked: await each(name => engine.isFactEntityUnbacked(ids.get(name)!, 'default')),
        unbackedWrongSource: await engine.isFactEntityUnbacked(ids.get('b-unbacked')!, 'other'),
        unbackedUnknown: await engine.isFactEntityUnbacked(unknown, 'default'),
        linked: await each(name => linked(name)),
        linkedWorld: await each(name => linked(name, { worldOnly: true })),
        linkedFloor: await each(name => linked(name, { worldOnly: true, remoteFloor: true })),
        linkedUnrestrictedFloor: await withCallerAccess({ restricted: false }, () => each(name => linked(name, { worldOnly: true, remoteFloor: true }))),
        linkedWrongSource: await linked('a-unlinked', { sourceId: 'other' }),
        linkedUnknown: await engine.readLinkedFactCopies({ id: unknown, sourceId: 'default', worldOnly: false, remoteFloor: false }),
        hidden: await each(name => engine.hasHiddenFactCopy({ id: ids.get(name)!, sourceId: 'default' })),
        hiddenUnrestricted: await withCallerAccess({ restricted: false }, () => each(name => engine.hasHiddenFactCopy({ id: ids.get(name)!, sourceId: 'default' }))),
        hiddenWrongSource: await engine.hasHiddenFactCopy({ id: ids.get('a-unlinked')!, sourceId: 'other' }),
        hiddenUnknown: await engine.hasHiddenFactCopy({ id: unknown, sourceId: 'default' }),
      };
      expect(out.unbacked).toEqual({ 'a-unlinked': false, 'b-unbacked': true, 'c-backed': false, 'k-backed': false, 'p-unlinked': false, 'd-unlinked': false, 'a-e': false });
      expect(out.unbackedWrongSource).toBe(false);
      expect(out.unbackedUnknown).toBe(false);
      expect(out.linked['a-unlinked']).toEqual(['a-e people/e-example', 'a-f-private-page people/f-example']);
      expect(out.linked['b-unbacked']).toEqual(['b-e people/e-example', 'b-readers people/r-example']);
      expect(out.linked['p-unlinked']).toEqual(['p-e people/e-example']);
      expect(out.linked['d-unlinked']).toEqual(['d-1 people/d1-example', 'd-2 people/d2-example', 'd-3 people/d3-example', 'd-4 people/d4-example', 'd-5 people/d5-example']);
      expect(out.linked['a-e']).toEqual(['a-f-private-page people/f-example']);
      expect(out.linkedWorld['p-unlinked']).toEqual([]);
      expect(out.linkedFloor['a-unlinked']).toEqual(['a-e people/e-example']);
      expect(out.linkedFloor['b-unbacked']).toEqual(['b-e people/e-example']);
      expect(out.linkedUnrestrictedFloor).toEqual(out.linkedFloor);
      expect(out.linkedWrongSource).toEqual([]);
      expect(out.linkedUnknown).toEqual([]);
      expect(out.hidden).toEqual({ 'a-unlinked': true, 'b-unbacked': true, 'c-backed': true, 'k-backed': false, 'p-unlinked': false, 'd-unlinked': false, 'a-e': false });
      expect(out.hiddenUnrestricted).toEqual(out.hidden);
      expect(out.hiddenWrongSource).toBe(false);
      expect(out.hiddenUnknown).toBe(false);
      return out;
    });

  const ownerRows: Array<{ name: string; entity: string | null; page: string | null }> = [
    { name: 'no page', entity: null, page: null },
    { name: 'missing pages', entity: 'people/nobody-example', page: 'notes/never-written' },
    { name: 'on open page', entity: null, page: 'notes/open' },
    { name: 'about open entity', entity: 'people/e-example', page: null },
    { name: 'on private page', entity: null, page: 'notes/private' },
    { name: 'on readers page', entity: null, page: 'notes/readers' },
    { name: 'on deleted page', entity: null, page: 'notes/deleted' },
    { name: 'on member page', entity: null, page: 'memory/members/alice-example' },
    { name: 'on scope page', entity: null, page: 'memory/scope' },
  ];
  async function ownerFixture(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
    await createSource(engine, backend, 'other');
    await engine.putPage('people/e-example', note('E'));
    await engine.putPage('notes/open', note('Open'));
    await engine.putPage('notes/private', note('Private', { visibility: 'private' }));
    await engine.putPage('notes/readers', note('Readers', { readable_by: ['member:alice-example'] }));
    await engine.putPage('notes/deleted', note('Deleted'));
    const ids = new Map<string, number>();
    for (const [i, r] of ownerRows.entries()) ids.set(r.name, await insert(engine, { fact: `owner fact ${i}`, entity: r.entity, page: r.page }, i + 1));
    await engine.softDeletePage('notes/deleted');
    return ids;
  }

  parityTest('ownerReachesFact for an owner with no member identity reaches only a fact on no page and no owned memory page',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFacts', 'softDeletePage', 'ownerReachesFact'] }, async (engine, backend) => {
      const ids = await ownerFixture(engine, backend);
      const out: Record<string, boolean> = {};
      for (const r of ownerRows) out[r.name] = await engine.ownerReachesFact({ id: ids.get(r.name)!, sourceId: 'default', identity: [], satisfied: [] });
      const extra = {
        wrongSource: await engine.ownerReachesFact({ id: ids.get('no page')!, sourceId: 'other', identity: [], satisfied: [] }),
        unknown: await engine.ownerReachesFact({ id: Math.max(...ids.values()) + 1000, sourceId: 'default', identity: [], satisfied: [] }),
      };
      expect(out).toEqual({
        'no page': true, 'missing pages': true, 'on open page': false, 'about open entity': false, 'on private page': false,
        'on readers page': false, 'on deleted page': false, 'on member page': false, 'on scope page': false,
      });
      expect(extra).toEqual({ wrongSource: false, unknown: false });
      return { out, extra };
    });

  parityTest('ownerReachesFact for an owner bound to a member reads its pages under the owner read rule',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFacts', 'softDeletePage', 'ownerReachesFact'] }, async (engine, backend) => {
      const ids = await ownerFixture(engine, backend);
      const out: Record<string, boolean> = {};
      for (const r of ownerRows) out[r.name] = await engine.ownerReachesFact({ id: ids.get(r.name)!, sourceId: 'default', identity: ['member:alice-example'], satisfied: [] });
      expect(out['no page']).toBe(true);
      expect(out['on open page']).toBe(true);
      expect(out['on private page']).toBe(false);
      expect(out['on member page']).toBe(false);
      expect(out['on scope page']).toBe(false);
      return out;
    });
});
