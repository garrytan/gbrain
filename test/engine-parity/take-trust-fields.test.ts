/**
 * BrainEngine parity — the trust tier and write origin each take write stamps.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every take write (addTakesBatch insert and in-place update, updateTake, supersedeTake, resolveTake,
 *    updateTakeEmbeddings) stamps `trust_tier` and `write_origin` as PGLite's `trust_tier_stamp` trigger does;
 *    readRowTrustRows({ table: 'takes' }) reads them back with the take's activation flag and contested ref; and the
 *    trust floor and flag suppression of listTakes and searchTakes hide the same takes on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that drops or misstamps a take's tier shows `takes_list` and `takes_search` callers the
 *    wrong trust labels, and a read with a trust floor or flag suppression is an access check: a take below the floor
 *    or flagged for activation must not reach the caller.
 *  - Why existing coverage misses it: takes.test.ts compares the Take rows, which carry no trust columns on any
 *    engine (`takeRowToTake` drops them), and cli-reads-import.test.ts reads timeline rows only.
 *  - Seam: none. Typed methods only (no executeRaw: D18); the trust context is declared through
 *    applyTransactionSettings inside a transaction, as the write paths do. Take and proposal ids are sequence values,
 *    so they are used for lookups and compared only as relations.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, Take, TakeBatchInput } from '../../src/core/engine.ts';
import { basisEmbedding, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { trustRaiseRefusal } from '../../src/core/trust/confirm.ts';

const { parityTest } = parityArms(testBackends());

const SLUG = 'people/take-trust-example';

/** Run `fn` in a transaction whose write trust context declares `tier` and `origin`. */
function declaredWrite(engine: BrainEngine, tier: string, origin: Record<string, unknown> | null, fn: (tx: BrainEngine) => Promise<unknown>) {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, origin ? JSON.stringify(origin) : '']);
    return fn(tx);
  });
}

const take = (page_id: number, row_num: number, claim: string, extra: Partial<TakeBatchInput> = {}): TakeBatchInput => ({
  page_id, row_num, claim, kind: 'take', holder: 'world', weight: 0.5, ...extra,
});

async function setup(engine: BrainEngine) {
  const page = await engine.putPage(SLUG, { type: 'person', title: 'T', compiled_truth: 'T', timeline: '' });
  return page.id;
}

/** Every take of the page (active and inactive), by row number. */
async function byRow(engine: BrainEngine, pageId: number): Promise<Map<number, Take>> {
  const rows = [...await engine.listTakes({ page_id: pageId, active: true }), ...await engine.listTakes({ page_id: pageId, active: false })];
  return new Map(rows.map(t => [t.row_num, t]));
}

interface TrustView { tier: string; origin: unknown; originKeys: string[] | null; flagged: boolean; contested: string | null }

/** The trust row of each take, keyed by row number; the take id is a lookup, never returned. */
async function trustByRow(engine: BrainEngine, pageId: number) {
  const takes = await byRow(engine, pageId);
  const rowOf = new Map([...takes.values()].map(t => [Number(t.id), t.row_num]));
  // readRowTrustRows has no ORDER BY on PGLite and Postgres: sort by row number before comparing.
  const rows = (await engine.readRowTrustRows({ table: 'takes', ids: [...rowOf.keys()] }))
    .sort((a, b) => rowOf.get(Number(a.id))! - rowOf.get(Number(b.id))!);
  expect(rows.length).toBe(rowOf.size);
  return Object.fromEntries(rows.map((r): [number, TrustView] => [rowOf.get(Number(r.id))!, {
    tier: r.trust_tier, origin: r.write_origin, originKeys: r.write_origin ? Object.keys(r.write_origin as object) : null,
    flagged: r.flagged, contested: r.contested,
  }]));
}

describe('engine parity: take trust fields', () => {
  parityTest('a take written under a declared trust context reads back its tier and origin, origin keys in jsonb order', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'addTakesBatch', 'listTakes', 'readRowTrustRows'],
  }, async (engine) => {
    const pageId = await setup(engine);
    await declaredWrite(engine, 'agent_written', { zz: 1, a: { y: 1, x: 2 }, mm: 3 }, tx => tx.addTakesBatch([take(pageId, 1, 'agent claim')]));
    await declaredWrite(engine, 'tool_observed', { channel: 'tool' }, tx => tx.addTakesBatch([take(pageId, 2, 'tool claim')]));
    await engine.addTakesBatch([take(pageId, 3, 'undeclared claim')]);
    const trust = await trustByRow(engine, pageId);
    expect(trust[1]).toEqual({ tier: 'agent_written', origin: { zz: 1, a: { y: 1, x: 2 }, mm: 3 }, originKeys: ['a', 'mm', 'zz'], flagged: false, contested: null });
    expect(trust[2]).toEqual({ tier: 'tool_observed', origin: { channel: 'tool' }, originKeys: ['channel'], flagged: false, contested: null });
    expect(trust[3]).toEqual({ tier: 'unknown', origin: null, originKeys: null, flagged: false, contested: null });
    return { trust, inner: Object.keys((trust[1]!.origin as Record<string, Record<string, number>>).a!) };
  });

  parityTest('a content update restamps the take; weight, resolve, supersede and embedding writes keep the stored pair', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'addTakesBatch', 'listTakes', 'updateTake', 'resolveTake',
      'supersedeTake', 'updateTakeEmbeddings', 'readRowTrustRows'],
  }, async (engine) => {
    const pageId = await setup(engine);
    const agent = { channel: 'agent' };
    await declaredWrite(engine, 'agent_written', agent, tx => tx.addTakesBatch([
      take(pageId, 1, 'changes claim'), take(pageId, 2, 'same content'), take(pageId, 3, 'weight only'),
      take(pageId, 4, 'resolved'), take(pageId, 5, 'superseded'), take(pageId, 6, 'embedded'),
    ]));
    const tool = { channel: 'tool' };
    const after: Record<string, unknown> = {};
    await declaredWrite(engine, 'tool_observed', tool, async (tx) => {
      await tx.addTakesBatch([take(pageId, 1, 'changes claim, new text'), take(pageId, 2, 'same content', { weight: 0.9 })]);
      await tx.updateTake(pageId, 3, { weight: 0.8 });
      await tx.resolveTake(pageId, 4, { quality: 'correct', resolvedBy: 'world' });
      after.supersede = await tx.supersedeTake(pageId, 5, { claim: 'the new claim', kind: 'take', holder: 'world', weight: 0.6 });
      const embedded = (await byRow(tx, pageId)).get(6)!;
      after.embedded = await tx.updateTakeEmbeddings([{ take_id: Number(embedded.id), embedding: basisEmbedding(1), claim: 'embedded', model: 'test-model' }]);
    });
    await engine.updateTake(pageId, 2, { weight: 0.1 });
    const trust = await trustByRow(engine, pageId);
    expect(trust[2]).toMatchObject({ tier: 'agent_written', origin: agent });
    expect(trust[3]).toMatchObject({ tier: 'agent_written', origin: agent });
    expect(trust[4]).toMatchObject({ tier: 'agent_written', origin: agent });
    expect(trust[6]).toMatchObject({ tier: 'agent_written', origin: agent });
    expect(trust[7]).toMatchObject({ tier: 'tool_observed', origin: tool });
    return { trust, after };
  });

  parityTest('a declared tier above operator_curated without owner confirmation refuses every take write', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'addTakesBatch', 'listTakes', 'updateTake', 'readRowTrustRows'],
  }, async (engine) => {
    const pageId = await setup(engine);
    await engine.addTakesBatch([take(pageId, 1, 'kept')]);
    const refused = async (fn: (tx: BrainEngine) => Promise<unknown>) => {
      try {
        await declaredWrite(engine, 'user_confirmed', { channel: 'owner' }, fn);
        return 'written';
      } catch (e) {
        // PGLite and Postgres raise it from the tier trigger (SQLSTATE P0001); the Rust store raises its typed code with
        // no SQLSTATE. trustRaiseRefusal must read both as the registered error.
        return trustRaiseRefusal(e)?.code ?? `other: ${(e as Error).message}`;
      }
    };
    const outcome = {
      insert: await refused(tx => tx.addTakesBatch([take(pageId, 2, 'new')])),
      unchanged: await refused(tx => tx.addTakesBatch([take(pageId, 1, 'kept')])),
      update: await refused(tx => tx.updateTake(pageId, 1, { weight: 0.7 })),
    };
    expect(outcome).toEqual({ insert: 'trust_raise_refused', unchanged: 'trust_raise_refused', update: 'trust_raise_refused' });
    const trust = await trustByRow(engine, pageId);
    expect(Object.keys(trust)).toEqual(['1']);
    return { outcome, trust };
  });

  parityTest('a trust floor hides takes below it from listTakes and searchTakes', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'addTakesBatch', 'listTakes', 'searchTakes'],
  }, async (engine) => {
    const pageId = await setup(engine);
    await declaredWrite(engine, 'operator_curated', { channel: 'operator' }, tx => tx.addTakesBatch([take(pageId, 1, 'floor probe operator claim')]));
    await declaredWrite(engine, 'agent_written', { channel: 'agent' }, tx => tx.addTakesBatch([take(pageId, 2, 'floor probe agent claim')]));
    await engine.addTakesBatch([take(pageId, 3, 'floor probe unknown claim')]);
    const list = async (floor?: string) => (await engine.listTakes({ page_id: pageId, eligibility: floor ? { floor: floor as never } : {} }))
      .map(t => t.row_num).sort();
    const search = async (floor?: string) => (await engine.searchTakes('floor probe claim', { eligibility: floor ? { floor: floor as never } : {} }))
      .map(t => t.row_num).sort();
    const view = {
      list: { none: await list(), agent: await list('agent_written'), operator: await list('operator_curated') },
      search: { none: await search(), agent: await search('agent_written'), operator: await search('operator_curated') },
    };
    expect(view.list.agent).not.toContain(3);
    expect(view.list.operator).toEqual([1]);
    expect(view.search.operator).not.toContain(2);
    expect(view.search.operator).not.toContain(3);
    return view;
  });

  parityTest('flag suppression hides a take an instruction-family write-gate receipt flags', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'addTakesBatch', 'listTakes', 'searchTakes', 'upsertWriteGateReceipt', 'readRowTrustRows'],
  }, async (engine) => {
    const pageId = await setup(engine);
    const agent = { channel: 'agent' };
    await declaredWrite(engine, 'agent_written', agent, tx => tx.addTakesBatch([
      take(pageId, 1, 'flag probe override claim'), take(pageId, 2, 'flag probe other claim'), take(pageId, 3, 'flag probe clean claim'),
    ]));
    await declaredWrite(engine, 'operator_curated', { channel: 'operator' }, tx => tx.addTakesBatch([take(pageId, 4, 'flag probe operator claim')]));
    const takes = await byRow(engine, pageId);
    const families: Record<number, string[]> = { 1: ['override'], 2: ['other'], 4: ['credential'] };
    for (const [row, f] of Object.entries(families)) {
      await engine.upsertWriteGateReceipt({
        target_table: 'takes', target_id: String(takes.get(Number(row))!.id), source_id: 'default', content_hash: 'h1', tier: 'agent_written',
        detector_version: 1, verdict: 'flag', reason_families: f, reasons: f.map(x => `${x} found`), detector_error: false, request_id: null,
      });
    }
    const list = async (suppressFlagged: boolean) => (await engine.listTakes({ page_id: pageId, eligibility: { suppressFlagged } })).map(t => t.row_num).sort();
    const search = async (suppressFlagged: boolean) => (await engine.searchTakes('flag probe claim', { eligibility: { suppressFlagged } })).map(t => t.row_num).sort();
    const trust = await trustByRow(engine, pageId);
    const view = {
      flagged: Object.fromEntries(Object.entries(trust).map(([row, t]) => [row, t.flagged])),
      list: { all: await list(false), suppressed: await list(true) },
      search: { all: await search(false), suppressed: await search(true) },
    };
    expect(view.flagged).toEqual({ 1: true, 2: false, 3: false, 4: false });
    expect(view.list.suppressed).not.toContain(1);
    expect(view.search.suppressed).not.toContain(1);
    return view;
  });

  parityTest('a pending supersede_take proposal marks its target challenged and its related take challenger', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'addTakesBatch', 'listTakes', 'insertTrustProposal', 'readRowTrustRows'],
  }, async (engine) => {
    const pageId = await setup(engine);
    await declaredWrite(engine, 'agent_written', { channel: 'agent' }, tx => tx.addTakesBatch([
      take(pageId, 1, 'challenged claim'), take(pageId, 2, 'challenger claim'), take(pageId, 3, 'bystander claim'),
    ]));
    const takes = await byRow(engine, pageId);
    const id = (row: number) => Number(takes.get(row)!.id);
    const proposal = await engine.insertTrustProposal({
      action: 'supersede_take', sourceId: 'default', target: { table: 'takes', id: id(1) }, related: { table: 'takes', id: id(2) },
      before: { trust_tier: 'agent_written' }, after: { claim: 'challenger claim' }, proposer: 'fence_projection',
    });
    const trust = await trustByRow(engine, pageId);
    const contested = Object.fromEntries(Object.entries(trust).map(([row, t]) => [row, t.contested?.replace(`tp${proposal.id}:`, 'tp<id>:') ?? null]));
    expect(contested).toEqual({ 1: 'tp<id>:challenged', 2: 'tp<id>:challenger', 3: null });
    return contested;
  });

  parityTest('Take rows from listTakes carry no trust columns on any engine', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'addTakesBatch', 'listTakes', 'listActiveTakesForPages'],
  }, async (engine) => {
    const pageId = await setup(engine);
    await declaredWrite(engine, 'agent_written', { channel: 'agent' }, tx => tx.addTakesBatch([take(pageId, 1, 'agent claim')]));
    const rows = [...await engine.listTakes({ page_id: pageId }), ...((await engine.listActiveTakesForPages([pageId])).get(pageId) ?? [])];
    const keys = rows.map(r => ['trust_tier', 'write_origin', 'trust'].filter(k => k in r));
    expect(keys).toEqual([[], []]);
    return keys;
  });
});
