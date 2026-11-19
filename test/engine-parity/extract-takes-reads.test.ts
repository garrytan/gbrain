/**
 * BrainEngine parity — the typed reads and the delete of `gbrain extract takes` (cycle/extract-takes.ts,
 * generations/adapters/take-rows.ts, trust/fence-guard.ts `guardTakeRows`, belief/coverage-report.ts `coveredSources`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member answers the statement its caller sent through `executeRaw`, row for row, on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: an arm that keeps a soft-deleted page live, lists a take the fence still states, misses a preimage,
 *    deletes evidence it should keep, or lets a lower-tier write past a more trusted take re-extracts a page wrongly.
 *  - Why existing coverage misses it: the statements ran through `executeRaw` inside the callers, which no parity case
 *    can call (D18); test/engine-parity/extract-takes.test.ts runs the whole write, which stops on Rust at the fence
 *    generation's raw SQL before most of these reads run.
 *  - Seam: `withWriteTrustSettings` stamps a take or page with its writer's tier; ids never compare across arms, so each
 *    answer names a take by its claim and a page by its slug.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { guardTakeRows } from '../../src/core/trust/fence-guard.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const body = (title: string, extra: Record<string, unknown> = {}) => ({ type: 'note' as const, title, compiled_truth: 'Body.', timeline: '', ...extra });

/** Fixture: run `fn` with the write trust settings `names` set to `values` for one transaction. */
async function withWriteTrustSettings<T>(engine: BrainEngine, names: string[], values: string[], fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(names, values);
    return fn(tx);
  });
}

/** Fixture: a page with takes at rows 1..n, claims `claims[i]`; returns the page id and a claim-by-id label. */
async function pageWithTakes(engine: BrainEngine, slug: string, claims: string[]) {
  const page = await engine.putPage(slug, body(slug));
  await engine.addTakesBatch(claims.map((claim, i) => ({ page_id: Number(page.id), row_num: i + 1, claim, kind: 'take', holder: 'h', weight: 0.5 })));
  const takes = await engine.listTakes({ page_id: Number(page.id) });
  return { pageId: Number(page.id), label: new Map(takes.map(t => [Number(t.id), t.claim])), idOf: (claim: string) => Number(takes.find(t => t.claim === claim)!.id) };
}

describe('engine parity: the page reads of the takes re-extract', () => {
  parityTest('readLivePageIdBySlug finds the live page of a source by slug; a deleted page, another source or no page is null', {
    methods: ['putPage', 'softDeletePage', 'readLivePageIdBySlug'],
  }, async (engine) => {
    const live = await engine.putPage('notes/live', body('Live'));
    await engine.putPage('notes/gone', body('Gone'));
    await engine.softDeletePage('notes/gone');
    const found = await engine.readLivePageIdBySlug('notes/live', SRC);
    expect(found).toBe(Number(live.id));
    const out = {
      live: found === Number(live.id),
      deleted: await engine.readLivePageIdBySlug('notes/gone', SRC),
      otherSource: await engine.readLivePageIdBySlug('notes/live', 'no-such-source'),
      missing: await engine.readLivePageIdBySlug('notes/missing', SRC),
    };
    expect(out).toEqual({ live: true, deleted: null, otherSource: null, missing: null });
    return out;
  });

  parityTest('readPageTierRef and readPageTierRows read a page\'s source, slug and stored tier, deleted or not', {
    methods: ['putPage', 'softDeletePage', 'readPageTierRef', 'readPageTierRows'],
  }, async (engine) => {
    const plain = await engine.putPage('notes/plain', body('Plain'));
    const curated = await withWriteTrustSettings(engine, ['gbrain.write_trust_tier', 'gbrain.write_trust_promotion'], ['operator_curated', 'operator_curated'],
      tx => tx.putPage('notes/curated', body('Curated')));
    const gone = await engine.putPage('notes/gone', body('Gone'));
    await engine.softDeletePage('notes/gone');
    const refs = {
      plain: await engine.readPageTierRef(Number(plain.id)),
      curated: await engine.readPageTierRef(Number(curated.id)),
      deleted: await engine.readPageTierRef(Number(gone.id)),
      missing: await engine.readPageTierRef(999_999),
    };
    expect(refs).toEqual({
      plain: { source_id: SRC, slug: 'notes/plain', trust_tier: 'unknown' },
      curated: { source_id: SRC, slug: 'notes/curated', trust_tier: 'operator_curated' },
      deleted: { source_id: SRC, slug: 'notes/gone', trust_tier: 'unknown' },
      missing: null,
    });
    const ids = [Number(plain.id), Number(curated.id), Number(gone.id), 999_999, Number(plain.id)];
    const rows = (await engine.readPageTierRows(ids)).map(({ id, ...r }) => ({ ...r, known: ids.includes(id) })).sort((a, b) => a.slug.localeCompare(b.slug));
    expect(rows.map(r => `${r.slug}=${r.trust_tier}`)).toEqual(['notes/curated=operator_curated', 'notes/gone=unknown', 'notes/plain=unknown']);
    const none = await engine.readPageTierRows([]);
    expect(none).toEqual([]);
    return { refs, rows, none };
  });

  parityTest('pageHasFrontmatterKey answers for a top-level key only, deleted page or not; no page has no key', {
    methods: ['putPage', 'softDeletePage', 'pageHasFrontmatterKey'],
  }, async (engine) => {
    const held = await engine.putPage('notes/held', body('Held', { frontmatter: { quarantine: { reason: 'parity fixture' }, tags: ['a'] } }));
    const nested = await engine.putPage('notes/nested', body('Nested', { frontmatter: { meta: { quarantine: true } } }));
    const gone = await engine.putPage('notes/gone', body('Gone', { frontmatter: { quarantine: 'yes' } }));
    await engine.softDeletePage('notes/gone');
    const out = {
      held: await engine.pageHasFrontmatterKey(Number(held.id), 'quarantine'),
      otherKey: await engine.pageHasFrontmatterKey(Number(held.id), 'reason'),
      nested: await engine.pageHasFrontmatterKey(Number(nested.id), 'quarantine'),
      deleted: await engine.pageHasFrontmatterKey(Number(gone.id), 'quarantine'),
      missing: await engine.pageHasFrontmatterKey(999_999, 'quarantine'),
    };
    expect(out).toEqual({ held: true, otherKey: false, nested: false, deleted: true, missing: false });
    return out;
  });
});

describe('engine parity: the take reads and the delete of the takes re-extract', () => {
  parityTest('listTakeIdsLeavingFence lists the takes at no listed row, or that no row restates with the same claim', {
    methods: ['putPage', 'addTakesBatch', 'listTakes', 'listTakeIdsLeavingFence'],
  }, async (engine) => {
    const { pageId, label } = await pageWithTakes(engine, 'notes/fence', ['one', 'two', 'three', 'four']);
    await pageWithTakes(engine, 'notes/fence-other', ['other one', 'other two']);
    const named = (ids: number[]) => ids.map(id => label.get(id) ?? `other:${id}`).sort();
    const out = {
      removed: named(await engine.listTakeIdsLeavingFence(pageId, { change: 'removed', rowNums: [1, 3, 9] })),
      removedAll: named(await engine.listTakeIdsLeavingFence(pageId, { change: 'removed', rowNums: [] })),
      replaced: named(await engine.listTakeIdsLeavingFence(pageId, { change: 'replaced', rows: [
        { row_num: 1, claim: 'one' }, { row_num: 2, claim: 'two restated' }, { row_num: 4, claim: 'four' }, { row_num: 7, claim: 'three' }] })),
      replacedNone: named(await engine.listTakeIdsLeavingFence(pageId, { change: 'replaced', rows: [] })),
      noPage: await engine.listTakeIdsLeavingFence(999_999, { change: 'removed', rowNums: [] }),
    };
    expect(out).toEqual({ removed: ['four', 'two'], removedAll: ['four', 'one', 'three', 'two'], replaced: ['three', 'two'],
      replacedNone: ['four', 'one', 'three', 'two'], noPage: [] });
    return out;
  });

  parityTest('listTakePreimages reads the before-state of the gone takes and of those an incoming row overwrites, by row', {
    methods: ['putPage', 'addTakesBatch', 'listTakes', 'resolveTake', 'listTakePreimages'],
  }, async (engine) => {
    const { pageId, idOf } = await pageWithTakes(engine, 'notes/preimage', ['one', 'two', 'three', 'four']);
    await engine.resolveTake(pageId, 2, { quality: 'correct', value: 12.5, unit: 'usd', source: 'filing', resolvedBy: 'tester' });
    const read = await engine.listTakePreimages(pageId, [idOf('three'), 999_999], [
      { row_num: 1, claim: 'one', kind: 'take', holder: 'h' },
      { row_num: 2, claim: 'two', kind: 'bet', holder: 'h' },
      { row_num: 4, claim: 'four', kind: 'take', holder: 'other holder' },
      { row_num: 3, claim: 'three', kind: 'take', holder: 'h' },
      { row_num: 8, claim: 'eight', kind: 'take', holder: 'h' },
    ]);
    const rows = read.map(({ preimage, gone }) => {
      const { id, page_id, resolved_at, weight, ...rest } = preimage;
      return { ...rest, weight: Number(Number(weight).toFixed(4)), id: id === idOf(rest.claim), page_id: page_id === pageId,
        resolved_at: resolved_at === null ? null : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?[+-]\d\d:\d\d$/.test(resolved_at), gone };
    });
    expect(rows.map(r => [r.row_num, r.claim, r.gone])).toEqual([[2, 'two', false], [3, 'three', true], [4, 'four', false]]);
    expect(rows[0]).toMatchObject({ resolved_at: true, resolved_quality: 'correct', resolved_outcome: true, resolved_value: 12.5, resolved_unit: 'usd',
      resolved_source: 'filing', resolved_by: 'tester', id: true, page_id: true });
    const none = await engine.listTakePreimages(pageId, [], []);
    expect(none).toEqual([]);
    return { rows, none };
  });

  parityTest('deleteTakesByIds deletes the listed takes on any page with the evidence citing them, and nothing for an empty list', {
    methods: ['putPage', 'addTakesBatch', 'listTakes', 'addSynthesisEvidence', 'deleteTakesByIds'],
  }, async (engine) => {
    const a = await pageWithTakes(engine, 'notes/delete-a', ['a one', 'a two']);
    const b = await pageWithTakes(engine, 'notes/delete-b', ['b one', 'b two']);
    const synth = await engine.putPage('notes/synthesis', body('Synthesis'));
    const cite = (pageId: number, row: number, i: number) => ({ synthesis_page_id: Number(synth.id), take_page_id: pageId, take_row_num: row, citation_index: i });
    expect(await engine.addSynthesisEvidence([cite(a.pageId, 1, 1), cite(a.pageId, 2, 2), cite(b.pageId, 2, 3)])).toBe(3);
    await engine.deleteTakesByIds([]);
    await engine.deleteTakesByIds([a.idOf('a one'), b.idOf('b two'), 999_999]);
    const left = async (pageId: number) => (await engine.listTakes({ page_id: pageId })).map(t => t.claim).sort();
    const remaining = { a: await left(a.pageId), b: await left(b.pageId) };
    // The evidence citing a deleted take went with it: with the take back, citing it again inserts; the kept citation stays.
    await engine.addTakesBatch([{ page_id: a.pageId, row_num: 1, claim: 'a one again', kind: 'take', holder: 'h', weight: 0.5 }]);
    const recited = await engine.addSynthesisEvidence([cite(a.pageId, 1, 4)]);
    const kept = await engine.addSynthesisEvidence([cite(a.pageId, 2, 5)]);
    const out = { ...remaining, recited, kept };
    expect(out).toEqual({ a: ['a two'], b: ['b one'], recited: 1, kept: 0 });
    return out;
  });

  parityTest('findTakeId finds the page\'s take at a row number, or null', {
    methods: ['putPage', 'addTakesBatch', 'listTakes', 'findTakeId'],
  }, async (engine) => {
    const { pageId, idOf } = await pageWithTakes(engine, 'notes/find', ['one', 'two']);
    const out = {
      two: (await engine.findTakeId(pageId, 2)) === idOf('two'),
      noRow: await engine.findTakeId(pageId, 9),
      noPage: await engine.findTakeId(999_999, 1),
    };
    expect(out).toEqual({ two: true, noRow: null, noPage: null });
    return out;
  });
});

describe('engine parity: the batch guard of the takes re-extract', () => {
  parityTest('listGuardedTakeRows holds the more trusted takes a batch deletes, replaces or deactivates, or that a pending forget holds', {
    methods: ['putPage', 'addTakesBatch', 'listTakes', 'insertTrustProposal', 'listGuardedTakeRows'],
  }, async (engine) => {
    const p = await engine.putPage('notes/guard', body('Guard'));
    const q = await engine.putPage('notes/guard-other', body('Guard other'));
    const add = (pageId: number, rowNum: number, claim: string, tier: string) => withWriteTrustSettings(engine,
      ['gbrain.write_trust_tier', 'gbrain.write_trust_promotion'], [tier, tier],
      tx => tx.addTakesBatch([{ page_id: pageId, row_num: rowNum, claim, kind: 'take', holder: 'h', weight: 0.5 }]));
    const P = Number(p.id), Q = Number(q.id);
    for (const [pageId, row, claim, tier] of [[P, 1, 'kept', 'operator_curated'], [P, 2, 'replaced', 'operator_curated'], [P, 3, 'deactivated', 'operator_curated'],
      [P, 4, 'removed', 'operator_curated'], [P, 5, 'plain', ''], [Q, 1, 'other removed', 'operator_curated'], [Q, 2, 'other plain', '']] as const) {
      expect(await add(pageId, row, claim, tier)).toBe(1);
    }
    const takes = [...await engine.listTakes({ page_id: P }), ...await engine.listTakes({ page_id: Q })];
    const label = new Map(takes.map(t => [Number(t.id), t.claim]));
    const incoming = [
      { page_id: P, row_num: 1, claim: 'kept', kind: 'take', holder: 'h', active: true },
      { page_id: P, row_num: 2, claim: 'replaced now', kind: 'take', holder: 'h', active: true },
      { page_id: P, row_num: 3, claim: 'deactivated', kind: 'take', holder: 'h', active: false },
      { page_id: P, row_num: 5, claim: 'plain now', kind: 'take', holder: 'h', active: true },
    ];
    const gone = [{ page_id: P, row_num: 4 }, { page_id: Q, row_num: 1 }, { page_id: Q, row_num: 2 }];
    const named = (rows: Awaited<ReturnType<typeof guardTakeRows>>) => rows.map(r => `${label.get(r.id) ?? `other:${r.id}`}@${r.page_id === P ? 'P' : 'Q'}${r.row_num}=${r.tier}/${r.change}`);
    const guard = (tier: string, opts: { pending?: boolean } = {}) => withWriteTrustSettings(engine, ['gbrain.write_trust_tier'], [tier],
      async tx => named(await guardTakeRows(tx, incoming, gone, opts)));
    // An agent-tier batch may not replace, deactivate or delete the operator-curated takes; the unchanged one and the plain ones pass.
    const agent = await guard('agent_written');
    expect(agent).toEqual(['replaced@P2=operator_curated/replaced', 'deactivated@P3=operator_curated/deactivated',
      'removed@P4=operator_curated/removed', 'other removed@Q1=operator_curated/removed']);
    const curated = await guard('operator_curated');
    expect(curated).toEqual([]);
    // A pending forget on the plain take holds it only when the open contest is asked for.
    expect((await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'takes', id: takes.find(t => t.claim === 'plain')!.id },
      before: {}, proposer: 'test' })).created).toBe(true);
    const curatedPending = await guard('operator_curated', { pending: true });
    expect(curatedPending).toEqual(['plain@P5=unknown/replaced']);
    const empty = await withWriteTrustSettings(engine, ['gbrain.write_trust_tier'], ['agent_written'], tx => tx.listGuardedTakeRows({ incoming: [], gone: [] }));
    expect(empty).toEqual([]);
    return { agent, curated, curatedPending, empty };
  });
});

describe('engine parity: the belief coverage read of the takes re-extract', () => {
  parityTest('listCoveredSources lists no source for a brain with no belief event', {
    methods: ['putPage', 'listCoveredSources'],
  }, async (engine) => {
    await engine.putPage('notes/belief', body('Belief'));
    const covered = await engine.listCoveredSources('["coverage"]');
    expect(covered).toEqual([]);
    return { covered };
  });
});
