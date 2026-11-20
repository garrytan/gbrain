/**
 * BrainEngine parity — the belief ledger's page lifetime writes (engine-sql/collate-belief-lifetimes.ts): the open
 * lifetime read (`readOpenLifetimes`), the mint (`mintLifetime`), the end (`endLifetime`), the rename
 * (`renameLifetime`) and the moved-page read `resolveLifetimes` makes (`readMovedLifetimes`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    a mint opens a lifetime at (incarnation, slug) and a second mint there answers the same one; an end closes it, once;
 *    a rename keeps the lifetime and moves its slug and page hint, so a swap of two slugs works through a parked name, and
 *    an open lifetime may not take a slug another holds open; the moved-page read names an open lifetime whose hint is a
 *    page now at the lifetime's slug; `resolveLifetimes` mints, reuses, replaces a lifetime whose hint names another
 *    page, and follows a page that moved.
 *  - Regression: these ran through `executeRaw`, which the Rust engine refuses, so a Rust brain could not open a page
 *    lifetime, and with it no belief batch.
 *  - Why existing coverage misses it: test/belief-ledger-*.test.ts run the SQL engines only.
 *  - Seam: pages are written through `putPage`. Lifetime uuids differ by arm, so each case reports them as labels.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveLifetimes } from '../../src/core/belief/lifetimes.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER_INCARNATION = '11111111-2222-4333-8444-555555555555';

async function setup(engine: BrainEngine, slugs: string[]) {
  const ids = new Map<string, number>();
  for (const slug of slugs) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '' });
    ids.set(slug, (await engine.getPage(slug))!.id);
  }
  const incarnation = (await engine.readLedgerSource(SRC))!.incarnation;
  const need = (slug: string) => ({ sourceId: SRC, incarnation, slug, pageId: ids.get(slug)! });
  return { ids, incarnation, need };
}

/** Names lifetime uuids by the order they were first seen, so arms compare. */
function labels() {
  const seen = new Map<string, string>();
  const label = (uuid: string | null | undefined) => uuid == null ? null : seen.get(uuid) ?? (seen.set(uuid, `L${seen.size + 1}`), seen.get(uuid)!);
  return label;
}

const open = async (engine: BrainEngine, ids: Map<string, number>, incarnation: string, slugs: string[], label: (u: string) => string | null) =>
  (await engine.readOpenLifetimes(SRC, slugs.map(slug => ({ incarnation, slug }))))
    .map(r => ({ lifetime: label(r.page_lifetime), slug: r.slug, page: r.page_id == null ? null : [...ids.values()].indexOf(Number(r.page_id)), same: r.source_incarnation === incarnation }))
    .sort((a, b) => a.slug < b.slug ? -1 : 1);

describe('engine parity: the belief ledger page lifetimes', () => {
  parityTest('mintLifetime opens one lifetime per slug, endLifetime closes it once, and readOpenLifetimes sees only open ones', {
    methods: ['putPage', 'getPage', 'readLedgerSource', 'mintLifetime', 'endLifetime', 'readOpenLifetimes'],
  }, async (engine) => {
    const { ids, incarnation, need } = await setup(engine, ['a-page', 'b-page']);
    const label = labels();
    const first = await engine.mintLifetime(need('a-page'));
    const again = await engine.mintLifetime(need('a-page'));
    const second = await engine.mintLifetime(need('b-page'));
    const afterMint = await open(engine, ids, incarnation, ['a-page', 'b-page', 'nothing-here'], label);
    const elsewhere = await engine.readOpenLifetimes(SRC, [{ incarnation: OTHER_INCARNATION, slug: 'a-page' }]);
    const otherSource = await engine.readOpenLifetimes('other-source', [{ incarnation, slug: 'a-page' }]);
    await engine.endLifetime(first);
    await engine.endLifetime(first);
    await engine.endLifetime('6f9619ff-8b86-4d01-b42d-00cf4fc964f1');
    const afterEnd = await open(engine, ids, incarnation, ['a-page', 'b-page'], label);
    const reopened = await engine.mintLifetime(need('a-page'));
    const afterReopen = await open(engine, ids, incarnation, ['a-page'], label);
    const badEnd = await engine.endLifetime('not-a-uuid').then(() => 'saved', () => 'refused');
    expect(again).toBe(first);
    expect(second).not.toBe(first);
    expect(reopened).not.toBe(first);
    expect(afterMint.map(r => r.slug)).toEqual(['a-page', 'b-page']);
    expect(afterMint[0]!.page).toBe(0);
    expect(afterEnd.map(r => r.slug)).toEqual(['b-page']);
    expect(elsewhere).toEqual([]);
    expect(otherSource).toEqual([]);
    expect(badEnd).toBe('refused');
    return { first: label(first), again: label(again), second: label(second), reopened: label(reopened), afterMint, afterEnd, afterReopen, elsewhere, otherSource, badEnd };
  });

  parityTest('renameLifetime keeps the lifetime and moves its slug, swaps through a parked name, and refuses an open slug', {
    methods: ['putPage', 'getPage', 'readLedgerSource', 'mintLifetime', 'endLifetime', 'renameLifetime', 'readOpenLifetimes'],
  }, async (engine) => {
    const { ids, incarnation, need } = await setup(engine, ['a-page', 'b-page', 'c-page']);
    const label = labels();
    const a = await engine.mintLifetime(need('a-page'));
    const b = await engine.mintLifetime(need('b-page'));
    await engine.renameLifetime(a, `~moving-${a}`, ids.get('b-page')!);
    await engine.renameLifetime(b, 'a-page', ids.get('a-page')!);
    await engine.renameLifetime(a, 'b-page', ids.get('b-page')!);
    const swapped = await open(engine, ids, incarnation, ['a-page', 'b-page', `~moving-${a}`], label);
    const taken = await engine.renameLifetime(a, 'a-page', ids.get('a-page')!).then(() => 'renamed', () => 'refused');
    const afterRefused = await open(engine, ids, incarnation, ['a-page', 'b-page'], label);
    // A closed lifetime holds no slug, so it may be renamed onto one that is open; a rename of nothing changes nothing.
    await engine.endLifetime(a);
    await engine.renameLifetime(a, 'a-page', ids.get('a-page')!);
    await engine.renameLifetime('6f9619ff-8b86-4d01-b42d-00cf4fc964f1', 'c-page', ids.get('c-page')!);
    const afterEnded = await open(engine, ids, incarnation, ['a-page', 'b-page', 'c-page'], label);
    const moved = await engine.mintLifetime(need('c-page'));
    await engine.renameLifetime(moved, 'c-renamed', ids.get('c-page')!);
    const afterMove = await open(engine, ids, incarnation, ['c-page', 'c-renamed'], label);
    expect(swapped).toEqual([
      { lifetime: label(b), slug: 'a-page', page: 0, same: true },
      { lifetime: label(a), slug: 'b-page', page: 1, same: true },
    ]);
    expect(taken).toBe('refused');
    expect(afterRefused).toEqual(swapped);
    expect(afterEnded.map(r => r.slug)).toEqual(['a-page']);
    expect(afterMove.map(r => r.slug)).toEqual(['c-renamed']);
    return { swapped, taken, afterRefused, afterEnded, afterMove };
  });

  parityTest('readMovedLifetimes names an open lifetime whose hint is a page now at the lifetime slug', {
    methods: ['putPage', 'getPage', 'readLedgerSource', 'mintLifetime', 'endLifetime', 'renameLifetime', 'readMovedLifetimes'],
  }, async (engine) => {
    const { ids, incarnation, need } = await setup(engine, ['a-page', 'b-page', 'c-page']);
    const label = labels();
    const aId = ids.get('a-page')!;
    const bId = ids.get('b-page')!;
    const cId = ids.get('c-page')!;
    const read = async (pageIds: number[]) => (await engine.readMovedLifetimes(pageIds))
      .map(r => ({ page: pageIds.includes(Number(r.page_id)) ? [aId, bId, cId].indexOf(Number(r.page_id)) : -1, lifetime: label(r.page_lifetime), same: r.source_incarnation === incarnation }))
      .sort((x, y) => x.page - y.page);
    const a = await engine.mintLifetime(need('a-page'));
    // The lifetime of c-page sits at a slug no page has, so its page has not moved there; the hint of b-page's names another page.
    const c = await engine.mintLifetime({ ...need('c-page'), slug: 'c-old' });
    const b = await engine.mintLifetime(need('b-page'));
    await engine.renameLifetime(b, 'b-page', aId);
    const before = await read([aId, bId, cId]);
    await engine.renameLifetime(c, 'c-page', cId);
    const afterMove = await read([aId, bId, cId]);
    await engine.endLifetime(a);
    const afterEnd = await read([aId, bId, cId]);
    const none = await read([]);
    const unknown = await read([999999]);
    expect(before.map(r => r.page)).toEqual([0]);
    expect(afterMove.map(r => r.page)).toEqual([0, 2]);
    expect(afterEnd.map(r => r.page)).toEqual([2]);
    expect(none).toEqual([]);
    expect(unknown).toEqual([]);
    return { a: label(a), b: label(b), c: label(c), before, afterMove, afterEnd, none, unknown };
  });

  parityTest('resolveLifetimes mints, reuses, replaces a lifetime for another page, and follows a page that moved', {
    methods: ['putPage', 'getPage', 'readLedgerSource', 'mintLifetime', 'endLifetime', 'renameLifetime', 'readOpenLifetimes', 'readMovedLifetimes'],
  }, async (engine) => {
    const { ids, incarnation, need } = await setup(engine, ['a-page', 'b-page', 'c-page']);
    const label = labels();
    const aId = ids.get('a-page')!;
    const bId = ids.get('b-page')!;
    const cId = ids.get('c-page')!;
    const minted = await resolveLifetimes(engine, [need('a-page'), need('b-page'), need('a-page')]);
    const reused = await resolveLifetimes(engine, [need('a-page'), need('b-page')]);
    // b-page's hint is rewritten to another page (an untracked writer replaced the page), so its lifetime is ended and a new one minted.
    await engine.renameLifetime(minted.get(bId)!, 'b-page', aId);
    const replaced = await resolveLifetimes(engine, [need('b-page')]);
    // c-page's lifetime was minted at a slug the page has since left: the caller's read is stale, and the page's own lifetime is used.
    const old = await engine.mintLifetime({ ...need('c-page'), slug: 'c-old' });
    await engine.renameLifetime(old, 'c-page', cId);
    const followed = await resolveLifetimes(engine, [{ ...need('c-page'), slug: 'c-old' }]);
    const empty = await resolveLifetimes(engine, []);
    const rows = await open(engine, ids, incarnation, ['a-page', 'b-page', 'c-page', 'c-old'], label);
    expect(minted.get(aId)).toBeTruthy();
    expect(minted.get(aId)).not.toBe(minted.get(bId));
    expect(reused.get(aId)).toBe(minted.get(aId)!);
    expect(reused.get(bId)).toBe(minted.get(bId)!);
    expect(replaced.get(bId)).not.toBe(minted.get(bId)!);
    expect(followed.get(cId)).toBe(old);
    expect(empty.size).toBe(0);
    expect(rows.map(r => r.slug)).toEqual(['a-page', 'b-page', 'c-page']);
    return {
      minted: [...minted].map(([id, l]) => [[aId, bId, cId].indexOf(id), label(l)]), reused: [...reused].map(([id, l]) => [[aId, bId, cId].indexOf(id), label(l)]),
      replaced: [...replaced].map(([id, l]) => [[aId, bId, cId].indexOf(id), label(l)]), followed: [...followed].map(([id, l]) => [[aId, bId, cId].indexOf(id), label(l)]), rows,
    };
  });
});
