/**
 * BrainEngine parity — takes family (+ contradiction probe cache and dream
 * verdict cache, which hang off the same tables' lifecycle).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every takes method (batch write, list/search, embeddings and
 *    their staleness, update/supersede/resolve, scorecard and calibration,
 *    synthesis evidence), the contradiction-probe run/cache methods and the
 *    dream-verdict cache return the same observable result on every engine
 *    arm (PGLite always; Postgres with DATABASE_URL; a Rust arm later through
 *    test/engine-parity/harness.ts).
 *  - Regression: an engine that drifts on take ordering and filters, on which
 *    holder rows an allow-list hides, on resolve/supersede immutability, on
 *    scorecard/Brier/calibration math, or on cache hit/miss semantics: the
 *    numbers `gbrain takes` and the dream cycle report.
 *  - Why existing coverage misses it: the takes and cache tests each run one
 *    engine; test/e2e/takes-postgres.test.ts needs Postgres and never diffs it
 *    against PGLite on one scenario.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, Take, TakeBatchInput, TakeHit } from '../../src/core/engine.ts';
import { basisEmbedding, createSource, parityArms, pick, sorted } from './harness.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const TAKE_KEYS = [
  'page_slug', 'row_num', 'claim', 'kind', 'holder', 'weight', 'since_date', 'until_date', 'source',
  'superseded_by', 'active', 'resolved_quality', 'resolved_outcome', 'resolved_value', 'resolved_unit',
  'resolved_source', 'resolved_by',
] as const;

const tv = (t: Take) => ({ ...pick(t, TAKE_KEYS), resolved: t.resolved_at !== null });
const claims = (rows: Array<{ claim: string }>) => rows.map((r) => r.claim);
const round = (n: number | null | undefined, places = 4) => (n == null ? n : Number(n.toFixed(places)));

/** Run `fn` and return the error's GBrainError `problem` code, or null when it did not throw. */
async function errorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { problem?: string }).problem ?? `non-gbrain:${(e as Error).constructor.name}`;
  }
}

async function page(engine: BrainEngine, slug: string, opts?: { sourceId?: string }) {
  const type = slug.startsWith('people/') ? 'person' : slug.startsWith('companies/') ? 'company' : 'note';
  return engine.putPage(slug, { type, title: slug, compiled_truth: `Page ${slug}.`, timeline: '' }, opts);
}

const take = (page_id: number, row_num: number, claim: string, extra: Partial<TakeBatchInput> = {}): TakeBatchInput => ({
  page_id, row_num, claim, kind: 'take', holder: 'garry', ...extra,
});

/** Map take ids to their claim text: ids are sequence-dependent and never compared across arms. */
// listTakes defaults to active rows only (`active ?? true`), so list both halves
async function allTakes(engine: BrainEngine, pageId: number) {
  return [...(await engine.listTakes({ page_id: pageId, active: true })), ...(await engine.listTakes({ page_id: pageId, active: false }))];
}

async function takeIds(engine: BrainEngine, pageId: number): Promise<Map<string, number>> {
  const rows = await allTakes(engine, pageId);
  return new Map(rows.map((r) => [r.claim, r.id]));
}

describe('engine parity: takes', () => {
  parityTest(
    'addTakesBatch inserts rows, is idempotent per (page, row_num), updates changed rows in place, clamps weight',
    { methods: ['putPage', 'addTakesBatch', 'listTakes'] },
    async (engine) => {
      const alice = await page(engine, 'people/alice-example');
      expect(await engine.addTakesBatch([])).toBe(0);
      const first = await engine.addTakesBatch([
        take(alice.id, 1, 'Alice will ship in Q3', { kind: 'bet', weight: 0.7, since_date: '2026-01-10', source: 'meeting' }),
        take(alice.id, 2, 'Alice prefers async work', { kind: 'take', weight: 0.4, holder: 'alice' }),
        take(alice.id, 3, 'Alice is in Austin', { kind: 'fact', weight: 1 }),
        take(alice.id, 4, 'Over-confident', { weight: 7 }),
        take(alice.id, 5, 'Under-confident', { weight: -3 }),
        take(alice.id, 6, 'Default weight'),
        take(alice.id, 7, 'Already inactive', { active: false, superseded_by: 6 }),
      ]);
      const initial = (await allTakes(engine, alice.id)).map(tv);
      // identical re-add counts every row and changes nothing
      const same = await engine.addTakesBatch([take(alice.id, 1, 'Alice will ship in Q3', { kind: 'bet', weight: 0.7, since_date: '2026-01-10', source: 'meeting' })]);
      // a changed claim/weight updates in place; still one row at that coordinate
      const changed = await engine.addTakesBatch([take(alice.id, 1, 'Alice will ship in Q4', { kind: 'bet', weight: 0.55, since_date: '2026-01-10', source: 'meeting' })]);
      const after = (await allTakes(engine, alice.id)).map(tv);
      expect([first, same, changed]).toEqual([7, 1, 1]);
      expect(initial.find((t) => t.row_num === 4)?.weight).toBe(1);
      expect(initial.find((t) => t.row_num === 5)?.weight).toBe(0);
      expect(initial.find((t) => t.row_num === 6)?.weight).toBe(0.5);
      expect(after.filter((t) => t.row_num === 1)).toHaveLength(1);
      expect(after.find((t) => t.row_num === 1)).toMatchObject({ claim: 'Alice will ship in Q4', weight: 0.55 });
      return { first, same, changed, initial: sorted(initial, (t) => String(t.row_num).padStart(3, '0')), after: sorted(after, (t) => String(t.row_num).padStart(3, '0')) };
    },
  );

  parityTest(
    'listTakes filters by page, holder, kind, active, resolved and holder allow-list',
    { methods: ['putPage', 'addTakesBatch', 'listTakes', 'resolveTake'] },
    async (engine) => {
      const alice = await page(engine, 'people/alice-example');
      const acme = await page(engine, 'companies/acme-example');
      await engine.addTakesBatch([
        take(alice.id, 1, 'a1 bet', { kind: 'bet', holder: 'garry', weight: 0.9 }),
        take(alice.id, 2, 'a2 take', { kind: 'take', holder: 'alice', weight: 0.3 }),
        take(alice.id, 3, 'a3 inactive', { kind: 'take', holder: 'garry', active: false }),
      ]);
      await engine.addTakesBatch([
        take(acme.id, 1, 'c1 fact', { kind: 'fact', holder: 'world', weight: 1 }),
        take(acme.id, 2, 'c2 bet', { kind: 'bet', holder: 'garry', weight: 0.6 }),
      ]);
      await engine.resolveTake(acme.id, 2, { quality: 'correct', resolvedBy: 'garry' });
      const q = async (opts?: Parameters<BrainEngine['listTakes']>[0]) => sorted(claims(await engine.listTakes(opts)));
      const out = {
        defaultActive: await q(),
        inactive: await q({ active: false }),
        activeUndefinedIsActive: await q({ active: undefined }),
        byPageId: await q({ page_id: alice.id }),
        byPageSlug: await q({ page_slug: 'companies/acme-example' }),
        byHolder: await q({ holder: 'garry' }),
        byKind: await q({ kind: 'bet' }),
        resolved: await q({ resolved: true }),
        unresolved: await q({ resolved: false }),
        allowGarry: await q({ takesHoldersAllowList: ['garry'] }),
        allowNobody: await q({ takesHoldersAllowList: [] }),
        allowWorldAlice: await q({ takesHoldersAllowList: ['world', 'alice'] }),
        missingSlug: await q({ page_slug: 'people/nobody' }),
      };
      expect(out.defaultActive).toEqual(['a1 bet', 'a2 take', 'c1 fact', 'c2 bet']);
      expect(out.inactive).toEqual(['a3 inactive']);
      expect(out.resolved).toEqual(['c2 bet']);
      expect(out.allowNobody).toEqual([]);
      return out;
    },
  );

  parityTest(
    'listTakes orders newest-first by default and by weight or since_date on request; pages with limit/offset',
    { methods: ['putPage', 'addTakesBatch', 'listTakes'] },
    async (engine) => {
      const p = await page(engine, 'notes/standup');
      await engine.addTakesBatch([
        take(p.id, 1, 't-low', { weight: 0.2, since_date: '2026-03-01' }),
        take(p.id, 2, 't-high', { weight: 0.9, since_date: '2025-12-31' }),
        take(p.id, 3, 't-mid', { weight: 0.5, since_date: '2026-06-15' }),
        take(p.id, 4, 't-undated', { weight: 0.5 }),
        take(p.id, 5, 't-month', { weight: 0.1, since_date: '2026-02' }),
      ]);
      const q = async (opts?: Parameters<BrainEngine['listTakes']>[0]) => claims(await engine.listTakes(opts));
      const byDefault = await q();
      const byWeight = await q({ sortBy: 'weight' });
      const sinceNewest = await q({ sortBy: 'since_date' });
      const sinceOldest = await q({ sortBy: 'since_date', oldestFirst: true });
      const onOrBefore = sorted(await q({ sinceOnOrBefore: '2026-03-01' }));
      const paged = await q({ sortBy: 'since_date', limit: 2, offset: 1 });
      expect(byWeight[0]).toBe('t-high');
      expect(byWeight[4]).toBe('t-month');
      expect(sinceNewest).toEqual(['t-mid', 't-low', 't-month', 't-high', 't-undated']);
      expect(sinceOldest).toEqual(['t-high', 't-month', 't-low', 't-mid', 't-undated']);
      expect(onOrBefore).toEqual(['t-high', 't-low', 't-month']);
      expect(paged).toEqual(['t-low', 't-month']);
      return { byDefault, byWeight, sinceNewest, sinceOldest, onOrBefore, paged };
    },
  );

  parityTest(
    'listTakes scopes to a source through the take page',
    { methods: ['putPage', 'addTakesBatch', 'listTakes'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'notes-src');
      const main = await page(engine, 'people/alice-example');
      const side = await page(engine, 'people/alice-example', { sourceId: 'notes-src' });
      await engine.addTakesBatch([take(main.id, 1, 'main source take')]);
      await engine.addTakesBatch([take(side.id, 1, 'side source take')]);
      const q = async (opts?: Parameters<BrainEngine['listTakes']>[0]) => sorted(claims(await engine.listTakes(opts)));
      const all = await q();
      const onlyMain = await q({ sourceId: 'default' });
      const onlySide = await q({ sourceId: 'notes-src' });
      const arrayWins = await q({ sourceId: 'default', sourceIds: ['notes-src'] });
      expect(all).toEqual(['main source take', 'side source take']);
      expect(onlyMain).toEqual(['main source take']);
      expect(onlySide).toEqual(['side source take']);
      expect(arrayWins).toEqual(['side source take']);
      return { all, onlyMain, onlySide, arrayWins };
    },
  );

  parityTest(
    'updateTake changes weight/since_date/source only, clamps weight, and rejects a missing row',
    { methods: ['putPage', 'addTakesBatch', 'updateTake', 'listTakes'] },
    async (engine) => {
      const p = await page(engine, 'people/alice-example');
      await engine.addTakesBatch([take(p.id, 1, 'Alice likes tea', { weight: 0.4, since_date: '2026-01-01', source: 'chat', holder: 'alice', kind: 'take' })]);
      const read = async () => tv((await engine.listTakes({ page_id: p.id }))[0]);
      await engine.updateTake(p.id, 1, { weight: 0.8 });
      const afterWeight = await read();
      await engine.updateTake(p.id, 1, { since_date: '2026-02-02', source: 'email' });
      const afterDateSource = await read();
      await engine.updateTake(p.id, 1, { weight: 9 });
      const afterClamp = await read();
      await engine.updateTake(p.id, 1, {});
      const afterNoop = await read();
      const missing = await errorCode(() => engine.updateTake(p.id, 99, { weight: 0.1 }));
      expect(afterWeight).toMatchObject({ weight: 0.8, since_date: '2026-01-01', source: 'chat', claim: 'Alice likes tea', holder: 'alice', kind: 'take' });
      expect(afterDateSource).toMatchObject({ weight: 0.8, since_date: '2026-02-02', source: 'email' });
      expect(afterClamp.weight).toBe(1);
      expect(afterNoop).toEqual(afterClamp);
      expect(missing).toBe('TAKE_ROW_NOT_FOUND');
      return { afterWeight, afterDateSource, afterClamp, afterNoop, missing };
    },
  );

  parityTest(
    'supersedeTake appends the new row, deactivates the old one, and refuses missing or resolved rows',
    { methods: ['putPage', 'addTakesBatch', 'supersedeTake', 'resolveTake', 'listTakes', 'listActiveTakesForPages'] },
    async (engine) => {
      const p = await page(engine, 'people/alice-example');
      await engine.addTakesBatch([
        take(p.id, 1, 'Alice will raise a seed', { kind: 'bet', weight: 0.6 }),
        take(p.id, 2, 'Alice likes tea'),
        take(p.id, 4, 'Row four exists already'),
      ]);
      const res = await engine.supersedeTake(p.id, 1, { claim: 'Alice will raise a Series A', kind: 'bet', holder: 'garry', weight: 0.8, since_date: '2026-05-01', source: 'update' });
      // next row_num is max+1, so it lands after the gap
      expect(res).toEqual({ oldRow: 1, newRow: 5 });
      const all = (await allTakes(engine, p.id)).map(tv);
      const active = claims(await engine.listTakes({ page_id: p.id }));
      const activeMap = await engine.listActiveTakesForPages([p.id]);
      expect(all.find((t) => t.row_num === 1)).toMatchObject({ active: false, superseded_by: 5 });
      expect(all.find((t) => t.row_num === 5)).toMatchObject({ active: true, claim: 'Alice will raise a Series A', weight: 0.8, superseded_by: null });
      expect(sorted(active)).toEqual(['Alice likes tea', 'Alice will raise a Series A', 'Row four exists already']);
      expect(claims(activeMap.get(p.id)!)).toEqual(['Alice likes tea', 'Row four exists already', 'Alice will raise a Series A']);

      await engine.resolveTake(p.id, 2, { quality: 'incorrect', resolvedBy: 'garry' });
      const resolvedErr = await errorCode(() => engine.supersedeTake(p.id, 2, { claim: 'x', kind: 'take', holder: 'garry' }));
      const missingErr = await errorCode(() => engine.supersedeTake(p.id, 77, { claim: 'x', kind: 'take', holder: 'garry' }));
      expect(resolvedErr).toBe('TAKE_RESOLVED_IMMUTABLE');
      expect(missingErr).toBe('TAKE_ROW_NOT_FOUND');
      return { res, all: sorted(all, (t) => String(t.row_num).padStart(3, '0')), resolvedErr, missingErr };
    },
  );

  parityTest(
    'resolveTake derives quality/outcome, stores resolution metadata, and is immutable',
    { methods: ['putPage', 'addTakesBatch', 'resolveTake', 'listTakes'] },
    async (engine) => {
      const p = await page(engine, 'companies/acme-example');
      await engine.addTakesBatch(
        [1, 2, 3, 4, 5, 6].map((n) => take(p.id, n, `bet ${n}`, { kind: 'bet', weight: 0.5 })),
      );
      await engine.resolveTake(p.id, 1, { quality: 'correct', value: 1200000, unit: 'usd', source: 'press release', resolvedBy: 'garry' });
      await engine.resolveTake(p.id, 2, { quality: 'incorrect', resolvedBy: 'garry' });
      await engine.resolveTake(p.id, 3, { quality: 'partial', resolvedBy: 'people/alice-example' });
      await engine.resolveTake(p.id, 4, { quality: 'unresolvable', resolvedBy: 'garry' });
      await engine.resolveTake(p.id, 5, { outcome: true, resolvedBy: 'garry' });
      await engine.resolveTake(p.id, 6, { outcome: false, resolvedBy: 'garry' });
      const rows = (await engine.listTakes({ page_id: p.id })).map(tv);
      const again = await errorCode(() => engine.resolveTake(p.id, 1, { quality: 'incorrect', resolvedBy: 'garry' }));
      const missing = await errorCode(() => engine.resolveTake(p.id, 42, { quality: 'correct', resolvedBy: 'garry' }));
      const noVerdict = await errorCode(() => engine.resolveTake(p.id, 1, { resolvedBy: 'garry' }));
      expect(again).toBe('TAKE_ALREADY_RESOLVED');
      expect(missing).toBe('TAKE_ROW_NOT_FOUND');
      const byRow = Object.fromEntries(rows.map((r) => [r.row_num, r]));
      expect(byRow[1]).toMatchObject({ resolved_quality: 'correct', resolved_outcome: true, resolved_value: 1200000, resolved_unit: 'usd', resolved_source: 'press release', resolved_by: 'garry', resolved: true });
      expect(byRow[2]).toMatchObject({ resolved_quality: 'incorrect', resolved_outcome: false });
      expect(byRow[3]).toMatchObject({ resolved_quality: 'partial', resolved_outcome: null, resolved_by: 'people/alice-example' });
      expect(byRow[4]).toMatchObject({ resolved_quality: 'unresolvable', resolved_outcome: null });
      expect(byRow[5]).toMatchObject({ resolved_quality: 'correct', resolved_outcome: true });
      expect(byRow[6]).toMatchObject({ resolved_quality: 'incorrect', resolved_outcome: false });
      return { rows: sorted(rows, (t) => String(t.row_num).padStart(3, '0')), again, missing, noVerdict };
    },
  );

  parityTest(
    'getScorecard counts bets, accuracy, Brier and partial/unresolvable rates, scoped by holder, domain, dates, allow-list and source',
    { methods: ['putPage', 'addTakesBatch', 'resolveTake', 'getScorecard'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'side');
      const acme = await page(engine, 'companies/acme-example');
      const alice = await page(engine, 'people/alice-example');
      const side = await page(engine, 'companies/side-example', { sourceId: 'side' });
      await engine.addTakesBatch([
        take(acme.id, 1, 'acme b1', { kind: 'bet', holder: 'garry', weight: 0.9, since_date: '2026-01-10' }),
        take(acme.id, 2, 'acme b2', { kind: 'bet', holder: 'garry', weight: 0.7, since_date: '2026-02-10' }),
        take(acme.id, 3, 'acme b3', { kind: 'bet', holder: 'garry', weight: 0.2, since_date: '2026-03-10' }),
        take(acme.id, 4, 'acme b4', { kind: 'bet', holder: 'garry', weight: 0.5, since_date: '2026-04-10' }),
        take(acme.id, 5, 'acme b5', { kind: 'bet', holder: 'garry', weight: 0.5, since_date: '2026-05-10' }),
        take(acme.id, 6, 'acme take (not a bet)', { kind: 'take', holder: 'garry', weight: 0.5 }),
      ]);
      await engine.addTakesBatch([
        take(alice.id, 1, 'alice b1', { kind: 'bet', holder: 'alice', weight: 0.6, since_date: '2026-02-20' }),
        take(alice.id, 2, 'alice b2', { kind: 'bet', holder: 'alice', weight: 0.4, since_date: '2026-06-01' }),
      ]);
      await engine.addTakesBatch([take(side.id, 1, 'side b1', { kind: 'bet', holder: 'garry', weight: 0.8, since_date: '2026-02-01' })]);
      await engine.resolveTake(acme.id, 1, { quality: 'correct', resolvedBy: 'garry' });
      await engine.resolveTake(acme.id, 2, { quality: 'incorrect', resolvedBy: 'garry' });
      await engine.resolveTake(acme.id, 3, { quality: 'correct', resolvedBy: 'garry' });
      await engine.resolveTake(acme.id, 4, { quality: 'partial', resolvedBy: 'garry' });
      await engine.resolveTake(acme.id, 5, { quality: 'unresolvable', resolvedBy: 'garry' });
      await engine.resolveTake(alice.id, 1, { quality: 'correct', resolvedBy: 'garry' });
      await engine.resolveTake(side.id, 1, { quality: 'incorrect', resolvedBy: 'garry' });
      const card = async (opts: Parameters<BrainEngine['getScorecard']>[0], allow?: string[]) => {
        const c = await engine.getScorecard(opts, allow);
        return { ...c, accuracy: round(c.accuracy), brier: round(c.brier), partial_rate: round(c.partial_rate), unresolvable_rate: round(c.unresolvable_rate) };
      };
      const all = await card({}, undefined);
      const holderGarry = await card({ holder: 'garry' }, undefined);
      const holderAlice = await card({ holder: 'alice' }, undefined);
      const domain = await card({ domainPrefix: 'companies/' }, undefined);
      const since = await card({ since: '2026-03-01' }, undefined);
      const until = await card({ until: '2026-02-28' }, undefined);
      const allowAlice = await card({}, ['alice']);
      const allowNobody = await card({}, []);
      const mainSource = await card({ sourceId: 'default' }, undefined);
      const sideSource = await card({ sourceId: 'side' }, undefined);
      const bothSources = await card({ sourceIds: ['default', 'side'] }, undefined);
      const emptyBrainHolder = await card({ holder: 'nobody' }, undefined);
      // 8 bets total (5 acme + 2 alice + 1 side); acme resolved 1+2+3+4 (partial) ; correct 3 incl. alice
      expect(all).toMatchObject({ total_bets: 8, resolved: 6, correct: 3, incorrect: 2, partial: 1, unresolvable_count: 1 });
      expect(all.accuracy).toBe(round(3 / 5));
      expect(allowNobody).toMatchObject({ total_bets: 0, resolved: 0, accuracy: null, brier: null });
      expect(emptyBrainHolder).toMatchObject({ total_bets: 0, accuracy: null, brier: null });
      return { all, holderGarry, holderAlice, domain, since, until, allowAlice, allowNobody, mainSource, sideSource, bothSources, emptyBrainHolder };
    },
  );

  parityTest(
    'getCalibrationCurve bins resolved correct/incorrect bets by weight and honors holder, bucket size and allow-list',
    { methods: ['putPage', 'addTakesBatch', 'resolveTake', 'getCalibrationCurve'] },
    async (engine) => {
      const p = await page(engine, 'companies/acme-example');
      const weights: Array<[number, 'correct' | 'incorrect' | 'partial', string]> = [
        [0.9, 'correct', 'garry'], [0.95, 'correct', 'garry'], [0.9, 'incorrect', 'garry'],
        [0.7, 'correct', 'garry'], [0.7, 'incorrect', 'alice'], [0.3, 'incorrect', 'garry'],
        [0.35, 'correct', 'alice'], [0.5, 'partial', 'garry'], [1, 'correct', 'garry'], [0, 'incorrect', 'garry'],
      ];
      await engine.addTakesBatch(weights.map(([w, , holder], i) => take(p.id, i + 1, `cal ${i + 1}`, { kind: 'bet', weight: w, holder })));
      await engine.addTakesBatch([take(p.id, 50, 'unresolved bet', { kind: 'bet', weight: 0.6 })]);
      for (const [i, [, quality]] of weights.entries()) await engine.resolveTake(p.id, i + 1, { quality, resolvedBy: 'garry' });
      const norm = (rows: Awaited<ReturnType<BrainEngine['getCalibrationCurve']>>) =>
        rows.map((r) => ({ lo: round(r.bucket_lo), hi: round(r.bucket_hi), n: r.n, observed: round(r.observed), predicted: round(r.predicted) }));
      const dflt = norm(await engine.getCalibrationCurve({}, undefined));
      const coarse = norm(await engine.getCalibrationCurve({ bucketSize: 0.5 }, undefined));
      const garry = norm(await engine.getCalibrationCurve({ holder: 'garry' }, undefined));
      const allow = norm(await engine.getCalibrationCurve({}, ['alice']));
      const none = norm(await engine.getCalibrationCurve({}, []));
      const badSize = norm(await engine.getCalibrationCurve({ bucketSize: 5 }, undefined));
      expect(dflt.reduce((a, b) => a + b.n, 0)).toBe(9); // partial and unresolved excluded
      expect(dflt.find((b) => b.lo === 0.9)).toMatchObject({ hi: 1, n: 4 }); // 0.9,0.95,0.9 and 1 (final bucket is inclusive of 1.0)
      expect(none).toEqual([]);
      expect(badSize).toEqual(dflt);
      return { dflt, coarse, garry, allow, none, badSize };
    },
  );

  parityTest(
    'addSynthesisEvidence inserts provenance rows once per (synthesis, take page, take row)',
    { methods: ['putPage', 'addTakesBatch', 'addSynthesisEvidence'] },
    async (engine) => {
      const synthesis = await page(engine, 'notes/think-2026-07');
      const source = await page(engine, 'people/alice-example');
      await engine.addTakesBatch([take(source.id, 1, 'cited one'), take(source.id, 2, 'cited two'), take(source.id, 3, 'cited three')]);
      expect(await engine.addSynthesisEvidence([])).toBe(0);
      const first = await engine.addSynthesisEvidence([
        { synthesis_page_id: synthesis.id, take_page_id: source.id, take_row_num: 1, citation_index: 1 },
        { synthesis_page_id: synthesis.id, take_page_id: source.id, take_row_num: 2, citation_index: 2 },
      ]);
      const repeat = await engine.addSynthesisEvidence([
        { synthesis_page_id: synthesis.id, take_page_id: source.id, take_row_num: 1, citation_index: 9 },
      ]);
      const mixed = await engine.addSynthesisEvidence([
        { synthesis_page_id: synthesis.id, take_page_id: source.id, take_row_num: 2, citation_index: 5 },
        { synthesis_page_id: synthesis.id, take_page_id: source.id, take_row_num: 3, citation_index: 3 },
      ]);
      expect([first, repeat, mixed]).toEqual([2, 0, 1]);
      return { first, repeat, mixed };
    },
  );

  parityTest(
    'listActiveTakesForPages groups active takes per page in row order, filters by allow-list, and keys empty pages',
    { methods: ['putPage', 'addTakesBatch', 'listActiveTakesForPages'] },
    async (engine) => {
      const a = await page(engine, 'people/alice-example');
      const b = await page(engine, 'people/bob-example');
      const empty = await page(engine, 'people/empty-example');
      await engine.addTakesBatch([
        take(a.id, 2, 'a second', { holder: 'alice' }),
        take(a.id, 1, 'a first', { holder: 'garry' }),
        take(a.id, 3, 'a inactive', { active: false }),
        take(b.id, 1, 'b only', { holder: 'garry' }),
      ]);
      const slugOf = new Map([[a.id, 'alice'], [b.id, 'bob'], [empty.id, 'empty'], [123456789, 'missing']]);
      const shape = (m: Map<number, Take[]>) => sorted([...m.entries()].map(([id, ts]) => `${slugOf.get(id)}=${claims(ts).join('|')}`));
      const all = shape(await engine.listActiveTakesForPages([a.id, b.id, empty.id, 123456789]));
      const garryOnly = shape(await engine.listActiveTakesForPages([a.id, b.id], { takesHoldersAllowList: ['garry'] }));
      const nobody = shape(await engine.listActiveTakesForPages([a.id], { takesHoldersAllowList: [] }));
      const none = (await engine.listActiveTakesForPages([])).size;
      expect(all).toEqual(['alice=a first|a second', 'bob=b only', 'empty=', 'missing=']);
      expect(none).toBe(0);
      return { all, garryOnly, nobody, none };
    },
  );

  parityTest(
    'searchTakes ranks active takes by trigram similarity and applies holder allow-list, source and limit',
    { methods: ['putPage', 'addTakesBatch', 'searchTakes'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'side');
      const a = await page(engine, 'people/alice-example');
      const s = await page(engine, 'people/side-example', { sourceId: 'side' });
      await engine.addTakesBatch([
        take(a.id, 1, 'Alice loves rust programming', { holder: 'garry', weight: 0.5 }),
        take(a.id, 2, 'Bob writes rust daily', { holder: 'alice', weight: 0.9 }),
        take(a.id, 3, 'Gardening is relaxing', { holder: 'garry' }),
        take(a.id, 4, 'Retired rust opinion', { holder: 'garry', active: false }),
      ]);
      await engine.addTakesBatch([take(s.id, 1, 'Side project in rust', { holder: 'garry', weight: 0.1 })]);
      const norm = (hits: TakeHit[]) => hits.map((h) => ({ slug: h.page_slug, row: h.row_num, claim: h.claim, holder: h.holder, weight: h.weight, score: round(h.score) }));
      const rust = norm(await engine.searchTakes('rust'));
      const limited = norm(await engine.searchTakes('rust', { limit: 1 }));
      const allow = norm(await engine.searchTakes('rust', { takesHoldersAllowList: ['alice'] }));
      const noOne = norm(await engine.searchTakes('rust', { takesHoldersAllowList: [] }));
      const side = norm(await engine.searchTakes('rust', { sourceId: 'side' }));
      const miss = norm(await engine.searchTakes('zzzzqqqq'));
      expect(rust.map((h) => h.claim)).not.toContain('Retired rust opinion');
      expect(rust.map((h) => h.claim)).not.toContain('Gardening is relaxing');
      expect(rust).toHaveLength(3);
      expect(allow.map((h) => h.claim)).toEqual(['Bob writes rust daily']);
      expect(noOne).toEqual([]);
      expect(side.map((h) => h.claim)).toEqual(['Side project in rust']);
      expect(miss).toEqual([]);
      return { rust, limited, allow, noOne, side, miss };
    },
  );

  parityTest(
    'take embeddings: write, read back, vector search, and staleness accounting',
    {
      methods: [
        'putPage', 'addTakesBatch', 'listTakes', 'updateTakeEmbeddings', 'getTakeEmbeddings', 'searchTakesVector',
        'countStaleTakes', 'listStaleTakes',
      ],
    },
    async (engine, backend) => {
      await createSource(engine, backend, 'side');
      const a = await page(engine, 'people/alice-example');
      const s = await page(engine, 'people/side-example', { sourceId: 'side' });
      await engine.addTakesBatch([
        take(a.id, 1, 'axis zero take', { holder: 'garry', weight: 0.5 }),
        take(a.id, 2, 'axis one take', { holder: 'alice', weight: 0.5 }),
        take(a.id, 3, 'never embedded take'),
        take(a.id, 4, 'inactive take', { active: false }),
      ]);
      await engine.addTakesBatch([take(s.id, 1, 'side axis zero take')]);
      const ids = await takeIds(engine, a.id);
      const sideIds = await takeIds(engine, s.id);
      const nameOf = new Map<number, string>([...ids, ...sideIds].map(([claim, id]) => [id, claim]));
      const staleClaims = async (opts?: Parameters<BrainEngine['listStaleTakes']>[0]) => (await engine.listStaleTakes(opts)).map((r) => r.claim);

      const beforeAll = await engine.countStaleTakes();
      expect(beforeAll).toBe(4); // active takes only: 3 on alice + 1 on side
      expect(await engine.updateTakeEmbeddings([])).toBe(0);

      // the takes.embedding column is the configured embedding width (1536 on a default brain)
      // The side take leans a little toward axis 2, so no two takes tie on cosine score: vector
      // search orders by distance alone (the shape its HNSW index serves), and an exact tie may come
      // back in either order. Its largest component stays on axis 0.
      const sideVector = basisEmbedding(0);
      sideVector[2] = 0.3;
      const written = await engine.updateTakeEmbeddings([
        { take_id: ids.get('axis zero take')!, embedding: basisEmbedding(0), claim: 'axis zero take', model: 'embed-m1' },
        { take_id: ids.get('axis one take')!, embedding: basisEmbedding(1), claim: 'axis one take', model: 'embed-m1' },
        { take_id: sideIds.get('side axis zero take')!, embedding: sideVector, claim: 'side axis zero take', model: 'embed-m1' },
        // claim drifted while the vector was in flight: discarded
        { take_id: ids.get('never embedded take')!, embedding: basisEmbedding(2), claim: 'an older claim text', model: 'embed-m1' },
        // inactive rows are ignored
        { take_id: ids.get('inactive take')!, embedding: basisEmbedding(3), claim: 'inactive take', model: 'embed-m1' },
      ]);
      expect(written).toBe(3);

      const stored = await engine.getTakeEmbeddings([...ids.values(), ...sideIds.values(), 987654321]);
      const storedView = sorted([...stored.entries()].map(([id, v]) => `${nameOf.get(id)}:${v.length}:${v.indexOf(1)}`));
      expect(storedView).toEqual(['axis one take:1536:1', 'axis zero take:1536:0', 'side axis zero take:1536:0']);
      expect((await engine.getTakeEmbeddings([])).size).toBe(0);

      const stale = {
        count: await engine.countStaleTakes(),
        claims: await staleClaims(),
        otherModel: await engine.countStaleTakes({ model: 'embed-m2' }),
        sameModel: await engine.countStaleTakes({ model: 'embed-m1' }),
        wrongDims: await engine.countStaleTakes({ dims: 768 }),
        rightDims: await engine.countStaleTakes({ dims: 1536 }),
        sideOnly: await staleClaims({ sourceId: 'side' }),
        defaultOnly: await staleClaims({ sourceId: 'default' }),
      };
      expect(stale.claims).toEqual(['never embedded take']);
      expect(stale.otherModel).toBe(4);
      expect(stale.sameModel).toBe(1);
      expect(stale.wrongDims).toBe(4);
      expect(stale.rightDims).toBe(1);
      expect(stale.sideOnly).toEqual([]);

      // vector search: cosine against the stored vectors, active + embedded rows only
      // scores against the query: axis zero 0.995, side 0.953, axis one 0.0995 (strictly ordered)
      const hit = (hits: TakeHit[]) => hits.map((h) => ({ claim: h.claim, score: round(h.score) }));
      const nearZero = new Float32Array(1536);
      nearZero[0] = 1;
      nearZero[1] = 0.1;
      const nearest = hit(await engine.searchTakesVector(nearZero));
      const nearestOne = hit(await engine.searchTakesVector(nearZero, { limit: 1 }));
      const allow = hit(await engine.searchTakesVector(nearZero, { takesHoldersAllowList: ['alice'] }));
      const sideScoped = hit(await engine.searchTakesVector(nearZero, { sourceId: 'side' }));
      const noOne = hit(await engine.searchTakesVector(nearZero, { takesHoldersAllowList: [] }));
      expect(nearest.map((h) => h.claim)).toEqual(['axis zero take', 'side axis zero take', 'axis one take']);
      expect(nearestOne.map((h) => h.claim)).toEqual(['axis zero take']);
      expect(allow.map((h) => h.claim)).toEqual(['axis one take']);
      expect(sideScoped.map((h) => h.claim)).toEqual(['side axis zero take']);
      expect(noOne).toEqual([]);

      // editing a claim through the batch upsert clears its vector (stale again); an unchanged claim keeps it
      await engine.addTakesBatch([
        take(a.id, 1, 'axis zero take, reworded', { holder: 'garry', weight: 0.5 }),
        take(a.id, 2, 'axis one take', { holder: 'alice', weight: 0.5 }),
      ]);
      const afterEdit = {
        stale: sorted(await staleClaims()),
        embeddings: sorted([...(await engine.getTakeEmbeddings([...ids.values()])).keys()].map((id) => nameOf.get(id)!)),
      };
      expect(afterEdit.stale).toEqual(['axis zero take, reworded', 'never embedded take']);
      expect(afterEdit.embeddings).toEqual(['axis one take']);

      const dupErr = await errorCode(() => engine.updateTakeEmbeddings([
        { take_id: ids.get('axis one take')!, embedding: basisEmbedding(1), claim: 'axis one take', model: 'embed-m1' },
        { take_id: ids.get('axis one take')!, embedding: basisEmbedding(1), claim: 'axis one take', model: 'embed-m1' },
      ]));
      expect(dupErr).not.toBeNull();
      return { beforeAll, written, storedView, stale, nearest, nearestOne, allow, sideScoped, noOne, afterEdit, rejectsDuplicateIds: dupErr !== null };
    },
  );

  parityTest(
    'matchTakeRows lists the stored takes a fence row would collide with, null-safe, ascending, limited, for one page only',
    { methods: ['putPage', 'addTakesBatch', 'matchTakeRows'] },
    async (engine) => {
      const alice = await page(engine, 'people/match-alice');
      const bob = await page(engine, 'people/match-bob');
      await engine.addTakesBatch([
        take(alice.id, 1, 'Same claim'), take(alice.id, 2, 'Original claim'), take(alice.id, 3, 'Holder moves'),
        take(alice.id, 4, 'Kind moves', { kind: 'bet' }), take(alice.id, 6, 'Unlisted by the fence'),
        take(bob.id, 2, 'Bob has row two too'),
      ]);
      const fence = (row_num: number, claim: string, extra: { kind?: string; holder?: string | null } = {}) =>
        ({ row_num, claim, kind: 'take', holder: 'garry', ...extra }) as never;
      const rows = [
        fence(4, 'Kind moves', { kind: 'take' }), fence(2, 'Edited claim'), fence(5, 'No stored row five'), fence(3, 'Holder moves', { holder: null }),
        fence(1, 'Same claim'), fence(6, 'Unlisted by the fence', { holder: 'someone-else' }),
      ];
      const all = await engine.matchTakeRows(alice.id, rows, 50);
      const limited = await engine.matchTakeRows(alice.id, rows, 2);
      const none = await engine.matchTakeRows(alice.id, [fence(1, 'Same claim'), fence(7, 'New row')], 50);
      const empty = await engine.matchTakeRows(alice.id, [], 50);
      const zero = await engine.matchTakeRows(alice.id, rows, 0);
      const otherPage = await engine.matchTakeRows(bob.id, rows, 50);
      const noPage = await engine.matchTakeRows(987654, rows, 50);
      // A stored take that two fence rows of its number both differ from is listed once for each, as the join lists it.
      const twice = await engine.matchTakeRows(alice.id, [fence(2, 'First edit'), fence(2, 'Second edit'), fence(2, 'Original claim')], 50);
      const answers = { all, limited, none, empty, zero, otherPage, noPage, twice };
      expect(answers).toEqual({ all: [2, 3, 4, 6], limited: [2, 3], none: [], empty: [], zero: [], otherPage: [2], noPage: [], twice: [2, 2] });
      return answers;
    },
  );

  parityTest(
    'deleteTakeRows deletes the page takes at the listed row numbers with their evidence, and an empty list deletes nothing',
    { methods: ['putPage', 'addTakesBatch', 'addSynthesisEvidence', 'listTakes', 'deleteTakeRows'] },
    async (engine) => {
      const alice = await page(engine, 'people/drop-alice');
      const bob = await page(engine, 'people/drop-bob');
      const synthesis = await page(engine, 'notes/drop-synthesis');
      await engine.addTakesBatch([
        take(alice.id, 1, 'Keep one'), take(alice.id, 2, 'Drop two'), take(alice.id, 3, 'Drop three', { active: false }), take(alice.id, 4, 'Keep four'),
        take(bob.id, 2, 'Bob row two stays'),
      ]);
      expect(await engine.addSynthesisEvidence([
        { synthesis_page_id: synthesis.id, take_page_id: alice.id, take_row_num: 2, citation_index: 1 },
        { synthesis_page_id: synthesis.id, take_page_id: alice.id, take_row_num: 4, citation_index: 2 },
      ])).toBe(2);
      const rows = async (pageId: number) => (await allTakes(engine, pageId)).map((t) => `${t.row_num}:${t.claim}`).sort();
      await engine.deleteTakeRows(alice.id, []);
      const afterEmpty = await rows(alice.id);
      await engine.deleteTakeRows(alice.id, [2, 3, 99, 2]);
      const afterDelete = { alice: await rows(alice.id), bob: await rows(bob.id) };
      await engine.deleteTakeRows(987654, [1, 2]);
      // The evidence went with its take: the same evidence row inserts again once the take is back; the kept take's row is still there.
      await engine.addTakesBatch([take(alice.id, 2, 'Back again')]);
      const evidenceAgain = await engine.addSynthesisEvidence([
        { synthesis_page_id: synthesis.id, take_page_id: alice.id, take_row_num: 2, citation_index: 1 },
        { synthesis_page_id: synthesis.id, take_page_id: alice.id, take_row_num: 4, citation_index: 2 },
      ]);
      const answers = { afterEmpty, afterDelete, evidenceAgain };
      expect(answers).toEqual({
        afterEmpty: ['1:Keep one', '2:Drop two', '3:Drop three', '4:Keep four'],
        afterDelete: { alice: ['1:Keep one', '4:Keep four'], bob: ['2:Bob row two stays'] },
        evidenceAgain: 1,
      });
      return answers;
    },
  );

  parityTest(
    'a claim edited through the batch upsert drops out of a vector search that ran before the edit',
    { methods: ['putPage', 'addTakesBatch', 'listTakes', 'updateTakeEmbeddings', 'searchTakesVector'] },
    async (engine) => {
      const a = await page(engine, 'people/alice-example');
      await engine.addTakesBatch([
        take(a.id, 1, 'axis zero take', { holder: 'garry', weight: 0.5 }),
        take(a.id, 2, 'axis one take', { holder: 'alice', weight: 0.5 }),
      ]);
      const ids = await takeIds(engine, a.id);
      expect(await engine.updateTakeEmbeddings([
        { take_id: ids.get('axis zero take')!, embedding: basisEmbedding(0), claim: 'axis zero take', model: 'embed-m1' },
        { take_id: ids.get('axis one take')!, embedding: basisEmbedding(1), claim: 'axis one take', model: 'embed-m1' },
      ])).toBe(2);
      const query = new Float32Array(1536);
      query[0] = 1;
      query[1] = 0.1;
      const claims = async () => (await engine.searchTakesVector(query)).map((h) => h.claim);
      // The first search warms whatever the engine keeps between reads.
      const before = await claims();
      // The claim changes; Postgres nulls the take's embedding in the same upsert, so the take has no vector to rank.
      await engine.addTakesBatch([take(a.id, 1, 'axis zero take, reworded', { holder: 'garry', weight: 0.5 })]);
      const after = await claims();
      expect(before).toEqual(['axis zero take', 'axis one take']);
      expect(after).toEqual(['axis one take']);
      return { before, after };
    },
  );

  parityTest(
    'inside a transaction a take vector read answers, and a rolled-back nested transaction takes its vectors out of the search',
    { methods: ['putPage', 'addTakesBatch', 'listTakes', 'updateTakeEmbeddings', 'searchTakesVector', 'hasStoredVectors', 'transaction'] },
    async (engine) => {
      const a = await page(engine, 'people/alice-example');
      await engine.addTakesBatch([take(a.id, 1, 'one take', { holder: 'garry', weight: 0.5 })]);
      const id = (await takeIds(engine, a.id)).get('one take')!;
      const embed = (on: BrainEngine, axis: number) =>
        on.updateTakeEmbeddings([{ take_id: id, embedding: basisEmbedding(axis), claim: 'one take', model: 'embed-m1' }]);
      const best = async (on: BrainEngine, axis: number) => round((await on.searchTakesVector(basisEmbedding(axis)))[0]?.score);
      await embed(engine, 2);
      const result = await engine.transaction(async (tx) => {
        // A read that scans the take vectors and reads each take, with one take vector stored.
        const stored = await tx.hasStoredVectors('takes');
        // A nested transaction (a savepoint) writes another vector, searches it, then rolls back.
        let seenInside = null as number | null | undefined;
        try {
          await tx.transaction(async (sp) => {
            await embed(sp, 0);
            seenInside = await best(sp, 0);
            throw new Error('roll the savepoint back');
          });
        } catch { /* the savepoint rolled back */ }
        await embed(tx, 1);
        return { stored, seenInside, afterRollback: await best(tx, 1), rolledBack: await best(tx, 0) };
      });
      expect(result).toEqual({ stored: true, seenInside: 1, afterRollback: 1, rolledBack: 0 });
      return result;
    },
  );
});

describe('engine parity: contradiction probe runs and judge cache', () => {
  const runRow = (id: string, over: Record<string, unknown> = {}) => ({
    run_id: id, judge_model: 'judge-m1', prompt_version: 'v1', queries_evaluated: 20, queries_with_contradiction: 4,
    total_contradictions_flagged: 6, wilson_ci_lower: 0.08, wilson_ci_upper: 0.42, judge_errors_total: 1, cost_usd_total: 0.37,
    duration_ms: 1234, source_tier_breakdown: { curated: 3, bulk: 1 }, report_json: { notes: ['a', 'b'], nested: { ok: true } }, ...over,
  });
  type Run = ReturnType<typeof runRow>;

  parityTest(
    'writeContradictionsRun is idempotent on run_id; loadContradictionsTrend returns runs newest first with parsed JSON',
    { methods: ['writeContradictionsRun', 'loadContradictionsTrend'] },
    async (engine) => {
      // ran_at defaults to the database clock's now(), and loadContradictionsTrend keeps rows with
      // ran_at >= a cutoff taken from the JS clock. Wait until the JS clock is strictly past the
      // newest stored ran_at (millisecond ISO) before the next write or the days=0 read, so neither
      // newest-first order nor the empty window depends on how fast the calls ran.
      const waitPastNewestRun = async () => {
        const newest = Date.parse((await engine.loadContradictionsTrend(7))[0]!.ran_at);
        expect(Number.isFinite(newest)).toBe(true);
        while (Date.now() <= newest) await new Promise((r) => setTimeout(r, 1));
      };
      const wrote: boolean[] = [];
      wrote.push(await engine.writeContradictionsRun(runRow('run-a') as Run));
      await waitPastNewestRun();
      wrote.push(await engine.writeContradictionsRun(runRow('run-b', { queries_evaluated: 30, cost_usd_total: 1.5, report_json: {} }) as Run));
      await waitPastNewestRun();
      wrote.push(await engine.writeContradictionsRun(runRow('run-a', { queries_evaluated: 999 }) as Run)); // same run_id: no-op
      wrote.push(await engine.writeContradictionsRun(runRow('run-c', { judge_model: 'judge-m2', source_tier_breakdown: {} }) as Run));
      expect(wrote).toEqual([true, true, false, true]);
      const trend = await engine.loadContradictionsTrend(7);
      expect(trend.map((r) => r.run_id)).toEqual(['run-c', 'run-b', 'run-a']);
      expect(trend.find((r) => r.run_id === 'run-a')?.queries_evaluated).toBe(20); // not overwritten
      expect(typeof trend[0].ran_at).toBe('string');
      await waitPastNewestRun();
      const nothing = await engine.loadContradictionsTrend(0);
      expect(nothing).toEqual([]);
      return {
        wrote,
        trend: trend.map(({ ran_at: _ranAt, ...rest }) => rest),
        nothing,
      };
    },
  );

  const key = { chunk_a_hash: 'hash-a', chunk_b_hash: 'hash-b', model_id: 'judge-m1', prompt_version: 'v1', truncation_policy: 'head-2k' };

  parityTest(
    'judge cache: put/get by the full 5-part key, upsert refreshes the verdict, other keys miss',
    { methods: ['putContradictionCacheEntry', 'getContradictionCacheEntry', 'sweepContradictionCache'] },
    async (engine) => {
      const empty = await engine.getContradictionCacheEntry(key);
      await engine.putContradictionCacheEntry({ ...key, verdict: { contradicts: true, confidence: 0.9, axes: ['date', 'amount'] } });
      const hit = await engine.getContradictionCacheEntry(key);
      await engine.putContradictionCacheEntry({ ...key, verdict: { contradicts: false } });
      const updated = await engine.getContradictionCacheEntry(key);
      const misses = {
        otherA: await engine.getContradictionCacheEntry({ ...key, chunk_a_hash: 'hash-z' }),
        otherB: await engine.getContradictionCacheEntry({ ...key, chunk_b_hash: 'hash-z' }),
        otherModel: await engine.getContradictionCacheEntry({ ...key, model_id: 'judge-m2' }),
        otherPrompt: await engine.getContradictionCacheEntry({ ...key, prompt_version: 'v2' }),
        otherTruncation: await engine.getContradictionCacheEntry({ ...key, truncation_policy: 'tail-2k' }),
      };
      // a second key lives beside the first; a short ttl is floored to 60s, so it is still live
      await engine.putContradictionCacheEntry({ ...key, prompt_version: 'v2', verdict: { contradicts: true }, ttl_seconds: 1 });
      const shortTtl = await engine.getContradictionCacheEntry({ ...key, prompt_version: 'v2' });
      // nothing has expired, so a sweep removes nothing and the entries stay readable
      const swept = await engine.sweepContradictionCache();
      const stillThere = await engine.getContradictionCacheEntry(key);
      expect(empty).toBeNull();
      expect(hit).toEqual({ contradicts: true, confidence: 0.9, axes: ['date', 'amount'] });
      expect(updated).toEqual({ contradicts: false });
      expect(Object.values(misses).every((m) => m === null)).toBe(true);
      expect(shortTtl).toEqual({ contradicts: true });
      expect(swept).toBe(0);
      return { empty, hit, updated, misses, shortTtl, swept, stillThere };
    },
  );
});

describe('engine parity: dream verdict cache', () => {
  const verdict = (over: Record<string, unknown> = {}) => ({
    worth_processing: true, reasons: ['mentions a decision', 'names a person'], score: 0.82, content_type: 'meeting',
    segments: [{ quote: 'we will ship in Q3', note: 'commitment' }, { quote: 'Alice owns it' }],
    entities: ['people/alice-example', 'companies/acme-example'], model: 'triage-m1', triage_version: 1, ...over,
  });
  type Verdict = ReturnType<typeof verdict>;

  parityTest(
    'putDreamVerdict/getDreamVerdict round-trip by (file, hash); a re-put replaces; sweep spares live rows',
    { methods: ['putDreamVerdict', 'getDreamVerdict', 'sweepDreamVerdicts'] },
    async (engine) => {
      const miss = await engine.getDreamVerdict('transcripts/a.md', 'h1');
      await engine.putDreamVerdict('transcripts/a.md', 'h1', verdict() as Verdict);
      const hit = await engine.getDreamVerdict('transcripts/a.md', 'h1');
      await engine.putDreamVerdict('transcripts/a.md', 'h1', verdict({ worth_processing: false, reasons: [], score: 0.1, content_type: null, segments: [], entities: [], model: 'triage-m2', triage_version: 2 }) as Verdict);
      const replaced = await engine.getDreamVerdict('transcripts/a.md', 'h1');
      // a backoff marker: no score, still stored
      await engine.putDreamVerdict('transcripts/b.md', 'h9', verdict({ score: null, worth_processing: false }) as Verdict);
      const backoff = await engine.getDreamVerdict('transcripts/b.md', 'h9');
      const otherHash = await engine.getDreamVerdict('transcripts/a.md', 'h2');
      const otherFile = await engine.getDreamVerdict('transcripts/c.md', 'h1');
      const swept = await engine.sweepDreamVerdicts();
      const afterSweep = await engine.getDreamVerdict('transcripts/a.md', 'h1');
      const strip = <T extends { judged_at: string } | null>(v: T) => (v ? { ...v, judged_at: typeof v.judged_at === 'string' && v.judged_at.length > 0 ? '<ts>' : v.judged_at } : v);
      expect(miss).toBeNull();
      expect(hit).toMatchObject({ worth_processing: true, reasons: ['mentions a decision', 'names a person'], score: 0.82, content_type: 'meeting', model: 'triage-m1', triage_version: 1 });
      expect(hit?.segments).toEqual([{ quote: 'we will ship in Q3', note: 'commitment' }, { quote: 'Alice owns it' }]);
      expect(replaced).toMatchObject({ worth_processing: false, reasons: [], score: 0.1, segments: [], entities: [], model: 'triage-m2', triage_version: 2 });
      expect(backoff?.score).toBeNull();
      expect(otherHash).toBeNull();
      expect(otherFile).toBeNull();
      expect(swept).toBe(0);
      expect(afterSweep).not.toBeNull();
      return { miss, hit: strip(hit), replaced: strip(replaced), backoff: strip(backoff), otherHash, otherFile, swept, afterSweep: strip(afterSweep) };
    },
  );
});

describe('engine parity: takes reads (group D)', () => {
  const NOTE = (slug: string) => ({ type: 'note' as const, title: slug, compiled_truth: `Page ${slug}.`, timeline: '' });

  parityTest(
    'countTakes and countOffGridTakeWeights count every take: inactive, resolved and soft-deleted-page takes included',
    { methods: ['putPage', 'addTakesBatch', 'softDeletePage', 'countTakes', 'countOffGridTakeWeights'] },
    async (engine) => {
      const empty = { takes: await engine.countTakes(), grid: await engine.countOffGridTakeWeights() };
      const a = await page(engine, 'notes/count-a');
      const gone = await page(engine, 'notes/count-gone');
      // every weight the typed API stores is on the 0.05 grid: it rounds them (the off-grid boundary is covered in
      // test/engine-sql-takes-reads.test.ts and the Rust store's own test)
      await engine.addTakesBatch([
        take(a.id, 1, 'on grid low', { weight: 0.05 }),
        take(a.id, 2, 'rounded down', { weight: 0.052 }),
        take(a.id, 3, 'rounded up', { weight: 0.074 }),
        take(a.id, 4, 'whole', { weight: 1 }),
        take(a.id, 5, 'zero', { weight: 0 }),
        take(a.id, 6, 'retired', { weight: 0.5, active: false }),
        take(gone.id, 1, 'on a deleted page', { weight: 0.35 }),
      ]);
      const live = { takes: await engine.countTakes(), grid: await engine.countOffGridTakeWeights() };
      await engine.softDeletePage('notes/count-gone');
      const afterDelete = { takes: await engine.countTakes(), grid: await engine.countOffGridTakeWeights() };
      expect(empty).toEqual({ takes: 0, grid: { off_grid: 0, total: 0 } });
      expect(live).toEqual({ takes: 7, grid: { off_grid: 0, total: 7 } });
      expect(afterDelete).toEqual(live);
      return { empty, live, afterDelete };
    },
  );

  parityTest(
    'listTakeRowsForPage returns the page takes by row number, active or not, and nothing for another page or an unknown id',
    { methods: ['putPage', 'addTakesBatch', 'listTakeRowsForPage'] },
    async (engine) => {
      const a = await page(engine, 'notes/rows-a');
      const b = await page(engine, 'notes/rows-b');
      await engine.addTakesBatch([
        take(a.id, 3, 'third'),
        take(a.id, 1, 'first', { active: false }),
        take(a.id, 2, 'second'),
        take(b.id, 1, 'elsewhere'),
      ]);
      const rows = await engine.listTakeRowsForPage(a.id);
      const other = await engine.listTakeRowsForPage(b.id);
      const unknown = await engine.listTakeRowsForPage(999_999);
      expect(rows.map((r) => [r.row_num, r.claim])).toEqual([[1, 'first'], [2, 'second'], [3, 'third']]);
      expect(other).toEqual([{ row_num: 1, claim: 'elsewhere' }]);
      expect(unknown).toEqual([]);
      return { rows, other, unknown };
    },
  );

  parityTest(
    'listHeldFenceTakeRows returns nothing for a page whose take fence generation is not held, takes or not',
    { methods: ['putPage', 'addTakesBatch', 'listHeldFenceTakeRows'] },
    async (engine) => {
      const a = await page(engine, 'notes/held-a');
      await engine.addTakesBatch([take(a.id, 1, 'first'), take(a.id, 2, 'second', { active: false })]);
      const spec = { sourceId: 'default', kind: 'take_fence', ownerKey: 'page:notes/held-a' };
      const withTakes = await engine.listHeldFenceTakeRows({ ...spec, pageId: a.id });
      const unknown = await engine.listHeldFenceTakeRows({ ...spec, pageId: 999_999 });
      expect(withTakes).toEqual([]);
      expect(unknown).toEqual([]);
      return { withTakes, unknown };
    },
  );

  parityTest(
    'listHeldFenceTakeRows returns the page takes by row number while its take fence generation is held fence_absent',
    { methods: ['putPage', 'addTakesBatch', 'recordHeldGenerationRow', 'listHeldFenceTakeRows'] },
    async (engine) => {
      const a = await page(engine, 'notes/held-b');
      await engine.addTakesBatch([take(a.id, 2, 'second', { active: false, weight: 0.25, since_date: '2026-01' }), take(a.id, 1, 'first', { source: 'a note' })]);
      const spec = { sourceId: 'default', kind: 'take_fence', ownerKey: 'page:notes/held-b' };
      const before = await engine.listHeldFenceTakeRows({ ...spec, pageId: a.id });
      await engine.transaction(tx => tx.recordHeldGenerationRow(spec, { holdId: 'h-fence', runId: null, inputPin: 'h-fence', inputSize: 1, setHash: 'h',
        reason: 'fence_absent', context: '{}', proposal: null, proposalBytes: 0 }));
      const rows = await engine.listHeldFenceTakeRows({ ...spec, pageId: a.id });
      const otherReason = { ...spec, ownerKey: 'page:notes/held-c' };
      await engine.transaction(tx => tx.recordHeldGenerationRow(otherReason, { holdId: 'h-proof', runId: null, inputPin: 'h-proof', inputSize: 1, setHash: 'h',
        reason: 'no_proof', context: '{}', proposal: null, proposalBytes: 0 }));
      const noProof = await engine.listHeldFenceTakeRows({ ...otherReason, pageId: a.id });
      const out = { before, rows: rows.map(r => ({ ...r, weight: Number(r.weight) })), noProof };
      expect(out.before).toEqual([]);
      expect(out.rows.map(r => [r.row_num, r.claim, r.active, r.weight, r.since_date, r.source])).toEqual([[1, 'first', true, 0.5, null, 'a note'], [2, 'second', false, 0.25, '2026-01', null]]);
      expect(out.noProof).toEqual([]);
      return out;
    },
  );

  parityTest(
    'planFactPurgeTakes plans the takes a purged fact consolidated into and the takes echoing its claim, within one source',
    { methods: ['putPage', 'addTakesBatch', 'insertFact', 'loadPurgeTarget', 'consolidateFact', 'planFactPurgeTakes'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'purge-other');
      const alice = await page(engine, 'people/purge-alice');
      const bob = await page(engine, 'people/purge-bob');
      const carol = await page(engine, 'people/purge-carol', { sourceId: 'purge-other' });
      const claim = 'Alice moved to Berlin';
      await engine.addTakesBatch([
        take(alice.id, 1, claim),
        take(alice.id, 2, 'Unrelated claim'),
        take(bob.id, 1, 'alice  MOVED to berlin.'),
        take(carol.id, 1, claim),
      ]);
      const fact = (text: string) => engine.insertFact({ fact: text, entity_slug: null, visibility: 'world', source: 'chat', embedding: null }, { source_id: 'default' });
      const hash = (await engine.loadPurgeTarget((await fact(claim)).id, 'default'))!.fact_hash;
      const none = (await engine.loadPurgeTarget((await fact('A claim no take makes')).id, 'default'))!.fact_hash;
      const named = await fact('Consolidated fact');
      const loose = await fact('Loose fact');
      const ids = { a1: (await takeIds(engine, alice.id)).get(claim)!, a2: (await takeIds(engine, alice.id)).get('Unrelated claim')!,
        b1: (await takeIds(engine, bob.id)).get('alice  MOVED to berlin.')!, c1: (await takeIds(engine, carol.id)).get(claim)! };
      await engine.consolidateFact(named.id, ids.a2);
      const label = new Map<number, string>([[ids.a1, 'alice#1'], [ids.a2, 'alice#2'], [ids.b1, 'bob#1'], [ids.c1, 'carol#1']]);
      const plan = async (sourceId: string, factIds: number[], factHash: string, subject: string) =>
        (await engine.planFactPurgeTakes({ sourceId, factIds, factHash, subject })).map((t) => `${label.get(t.id)}@${t.page_id === alice.id ? 'alice' : t.page_id === bob.id ? 'bob' : 'carol'}`);
      const out = {
        echoOnSubject: await plan('default', [], hash, 'people/purge-alice'),
        echoEverywhere: await plan('default', [], hash, '*'),
        echoOtherSource: await plan('purge-other', [], hash, '*'),
        echoUnknownSubject: await plan('default', [], hash, 'people/nobody'),
        noEcho: await plan('default', [], none, '*'),
        consolidated: await plan('default', [named.id], none, '*'),
        unconsolidated: await plan('default', [loose.id], none, '*'),
        consolidatedOtherSource: await plan('purge-other', [named.id], none, '*'),
        both: await plan('default', [named.id], hash, 'people/purge-alice'),
      };
      expect(out.echoOnSubject).toEqual(['alice#1@alice']);
      expect(out.echoEverywhere).toEqual(['alice#1@alice', 'bob#1@bob']);
      expect(out.echoOtherSource).toEqual(['carol#1@carol']);
      expect(out.consolidated).toEqual(['alice#2@alice']);
      expect(out.both).toEqual(['alice#1@alice', 'alice#2@alice']);
      expect([out.echoUnknownSubject, out.noEcho, out.unconsolidated, out.consolidatedOtherSource]).toEqual([[], [], [], []]);
      return out;
    },
  );

  parityTest(
    'countMcpResolvedTakes counts resolved takes stamped mcp: in the source and holder scope it is given',
    { methods: ['putPage', 'addTakesBatch', 'resolveTake', 'countMcpResolvedTakes'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'mcp-other');
      const a = await page(engine, 'notes/mcp-a');
      const o = await page(engine, 'notes/mcp-o', { sourceId: 'mcp-other' });
      await engine.addTakesBatch([
        take(a.id, 1, 'mcp by garry'),
        take(a.id, 2, 'mcp by alice', { holder: 'alice' }),
        take(a.id, 3, 'human'),
        take(a.id, 4, 'unresolved'),
        take(a.id, 5, 'stamp mid-string'),
        take(a.id, 6, 'capital stamp'),
        take(o.id, 1, 'mcp elsewhere'),
      ]);
      const done = { quality: 'correct' as const, outcome: true };
      await engine.resolveTake(a.id, 1, { ...done, resolvedBy: 'mcp:client-1' });
      await engine.resolveTake(a.id, 2, { ...done, resolvedBy: 'mcp:client-2' });
      await engine.resolveTake(a.id, 3, { ...done, resolvedBy: 'human:garry' });
      await engine.resolveTake(a.id, 5, { ...done, resolvedBy: 'not-mcp:x' });
      await engine.resolveTake(a.id, 6, { ...done, resolvedBy: 'MCP:client' });
      await engine.resolveTake(o.id, 1, { ...done, resolvedBy: 'mcp:client-3' });
      const count = (sourceIds: string[] | null, holders: string[] | null) => engine.countMcpResolvedTakes({ sourceIds, holders, excludePrivate: false });
      const out = {
        everything: await count(null, null),
        defaultSource: await count(['default'], null),
        otherSource: await count(['mcp-other'], null),
        bothSources: await count(['default', 'mcp-other'], null),
        noSuchSource: await count(['nowhere'], null),
        emptySources: await count([], null),
        garry: await count(null, ['garry']),
        garryAndAlice: await count(null, ['alice', 'garry']),
        emptyHolders: await count(null, []),
        defaultGarry: await count(['default'], ['garry']),
      };
      expect(out).toEqual({ everything: 3, defaultSource: 2, otherSource: 1, bothSources: 3, noSuchSource: 0, emptySources: 0, garry: 2, garryAndAlice: 3, emptyHolders: 0, defaultGarry: 1 });
      return out;
    },
  );

  /** Pages that differ by privacy state, each with one resolved `mcp:` take; the soft-deleted ones keep their rows. */
  async function mcpPrivacyFixture(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
    await createSource(engine, backend, 'mcp-priv-other');
    const put = async (slug: string, frontmatter: Record<string, unknown>, sourceId?: string) =>
      engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Page ${slug}.`, timeline: '', frontmatter }, sourceId ? { sourceId } : undefined);
    const pages = {
      open: await put('notes/mcp-open', {}),
      private: await put('notes/mcp-private', { visibility: 'private' }),
      readers: await put('notes/mcp-readers', { readable_by: ['alice-example'] }),
      alias: await put('notes/mcp-alias', { access: 'restricted' }),
      gone: await put('notes/mcp-gone', {}),
      otherOpen: await put('notes/mcp-other-open', {}, 'mcp-priv-other'),
      otherPrivate: await put('notes/mcp-other-private', { visibility: 'private' }, 'mcp-priv-other'),
    };
    await engine.softDeletePage('notes/mcp-gone');
    const done = { quality: 'correct' as const, outcome: true };
    let n = 0;
    for (const p of Object.values(pages)) {
      n += 1;
      await engine.addTakesBatch([take(p.id, 1, `resolved ${n}`, { holder: n % 2 ? 'garry' : 'alice' }), take(p.id, 2, `open ${n}`)]);
      await engine.resolveTake(p.id, 1, { ...done, resolvedBy: `mcp:client-${n}` });
    }
    return pages;
  }

  parityTest(
    'countMcpResolvedTakes under excludePrivate drops the takes of pages the page policy hides, in every source and holder scope',
    { methods: ['putPage', 'softDeletePage', 'addTakesBatch', 'resolveTake', 'countMcpResolvedTakes'] },
    async (engine, backend) => {
      await mcpPrivacyFixture(engine, backend);
      const count = (sourceIds: string[] | null, holders: string[] | null, excludePrivate: boolean) =>
        engine.countMcpResolvedTakes({ sourceIds, holders, excludePrivate });
      const out = {
        everythingOpen: await count(null, null, false),
        everythingHidden: await count(null, null, true),
        defaultOpen: await count(['default'], null, false),
        defaultHidden: await count(['default'], null, true),
        otherOpen: await count(['mcp-priv-other'], null, false),
        otherHidden: await count(['mcp-priv-other'], null, true),
        garryHidden: await count(null, ['garry'], true),
        aliceHidden: await count(null, ['alice'], true),
        noSourceHidden: await count([], null, true),
        noHolderHidden: await count(null, [], true),
      };
      // open, private, readers, alias, gone (default) and open, private (other): the live policy hides private, readers, alias, other-private.
      expect(out).toEqual({
        everythingOpen: 7, everythingHidden: 3, defaultOpen: 5, defaultHidden: 2, otherOpen: 2, otherHidden: 1,
        garryHidden: 2, aliceHidden: 1, noSourceHidden: 0, noHolderHidden: 0,
      });
      return out;
    },
  );

  parityTest(
    'countMcpResolvedTakes under excludePrivate applies the caller policy: a reader identity reads its readers page, a private-readable grant its source',
    { methods: ['putPage', 'softDeletePage', 'addTakesBatch', 'resolveTake', 'countMcpResolvedTakes'] },
    async (engine, backend) => {
      await mcpPrivacyFixture(engine, backend);
      const hidden = () => engine.countMcpResolvedTakes({ sourceIds: null, holders: null, excludePrivate: true });
      const out = {
        plain: await hidden(),
        reader: await withCallerAccess({ identity: ['member:alice-example'], hidePrivate: true }, hidden),
        stranger: await withCallerAccess({ identity: ['member:bob-example'], hidePrivate: true }, hidden),
        granted: await withCallerAccess({ privateReadableSources: ['mcp-priv-other'], hidePrivate: true }, hidden),
        readerGranted: await withCallerAccess({ identity: ['member:alice-example'], privateReadableSources: ['mcp-priv-other'], hidePrivate: true }, hidden),
      };
      // plain sees open and other-open; the reader adds the readers page, the grant adds other-private.
      expect(out).toEqual({ plain: 3, reader: 4, stranger: 3, granted: 4, readerGranted: 5 });
      return out;
    },
  );

  parityTest(
    'countMcpResolvedTakes under excludePrivate drops the takes of an owner-only source: every take while one exists with no schema version, only that source\'s and its concept lineage under the function form',
    { methods: ['putPage', 'addLink', 'addTakesBatch', 'resolveTake', 'countMcpResolvedTakes'] },
    async (engine, backend) => {
      const resolved = async (slug: string, type: 'note' | 'concept', sourceId: string, claim: string) => {
        const p = await engine.putPage(slug, { type, title: slug, compiled_truth: `Page ${slug}.`, timeline: '' }, { sourceId });
        await engine.addTakesBatch([take(p.id, 1, claim)]);
        await engine.resolveTake(p.id, 1, { quality: 'correct', outcome: true, resolvedBy: `mcp:client-${claim}` });
      };
      const counts = async () => {
        const count = (sourceIds: string[] | null) => engine.countMcpResolvedTakes({ sourceIds, holders: null, excludePrivate: true });
        return {
          everything: await count(null), default: await count(['default']), work: await count(['work']),
          chat: await count(['chat']), vault: await count(['vault']),
        };
      };
      await createSource(engine, backend, 'work');
      await resolved('notes/open', 'note', 'default', 'default-open');
      await resolved('concepts/from-chat', 'concept', 'default', 'default-concept');
      await resolved('notes/work', 'note', 'work', 'work-open');
      // Before any owner-only source exists every resolved take is counted: the case is not vacuous.
      const before = await counts();
      expect(before).toEqual({ everything: 3, default: 2, work: 1, chat: 0, vault: 0 });

      await createSource(engine, backend, 'chat', { kind: 'imessage' });
      await createSource(engine, backend, 'vault', { owner_only: true });
      await resolved('chat/thread', 'note', 'chat', 'chat-thread');
      await resolved('vault/notes', 'note', 'vault', 'vault-notes');
      await engine.addLink('concepts/from-chat', 'chat/thread', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { toSourceId: 'chat' });

      // No schema version in context: while an owner-only source exists the non-owner policy hides every take.
      const closed = await counts();
      expect(closed).toEqual({ everything: 0, default: 0, work: 0, chat: 0, vault: 0 });

      // Schema version 320 or later: only the owner-only sources' takes, and the concept synthesized from one, are hidden.
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      const fn = await withEngineScope(engine, counts);
      expect(fn).toEqual({ everything: 2, default: 1, work: 1, chat: 0, vault: 0 });
      return { before, closed, fn };
    },
  );

  parityTest(
    'listTakeSupersessionCandidates lists the live pages of the given sources that hold an inactive or superseded-by take, by page',
    { methods: ['putPage', 'addTakesBatch', 'softDeletePage', 'listTakeSupersessionCandidates'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'sup-other');
      const mk = (slug: string, sourceId?: string) => engine.putPage(slug, NOTE(slug), sourceId ? { sourceId } : undefined);
      const inactive = await mk('notes/sup-inactive');
      const named = await mk('notes/sup-named');
      const shouted = await mk('notes/sup-shouted');
      const plain = await mk('notes/sup-plain');
      const gone = await mk('notes/sup-gone');
      const elsewhere = await mk('notes/sup-elsewhere', 'sup-other');
      const blank = await mk('notes/sup-blank');
      await engine.addTakesBatch([
        take(inactive.id, 1, 'a', { active: false }),
        take(named.id, 1, 'b', { source: 'meeting; superseded by #2' }),
        take(shouted.id, 1, 'c', { source: 'SUPERSEDED BY #7' }),
        take(plain.id, 1, 'd', { source: 'superseded by 2' }),
        take(plain.id, 2, 'e'),
        take(gone.id, 1, 'f', { active: false }),
        take(elsewhere.id, 1, 'g', { active: false }),
        take(blank.id, 1, 'h', { source: '' }),
      ]);
      await engine.softDeletePage('notes/sup-gone');
      const view = (rows: Array<{ id: number; source_id: string; slug: string }>) => rows.map((r) => `${r.source_id}:${r.slug}`);
      const out = {
        defaultOnly: view(await engine.listTakeSupersessionCandidates(['default'])),
        both: view(await engine.listTakeSupersessionCandidates(['sup-other', 'default'])),
        none: view(await engine.listTakeSupersessionCandidates([])),
        unknown: view(await engine.listTakeSupersessionCandidates(['nowhere'])),
      };
      expect(out.defaultOnly).toEqual(['default:notes/sup-inactive', 'default:notes/sup-named', 'default:notes/sup-shouted']);
      expect(out.both).toHaveLength(4);
      expect([out.none, out.unknown]).toEqual([[], []]);
      return out;
    },
  );

  parityTest(
    'listTopResolvedTakesForHolder returns the holder\'s heaviest active resolved takes on any page, an undated take first within a weight',
    { methods: ['putPage', 'softDeletePage', 'addTakesBatch', 'resolveTake', 'listTopResolvedTakesForHolder'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'top-other');
      const a = await page(engine, 'notes/top-a');
      const gone = await page(engine, 'notes/top-gone');
      const o = await page(engine, 'notes/top-o', { sourceId: 'top-other' });
      await engine.addTakesBatch([
        take(a.id, 1, 'heavy dated', { holder: 'alice', weight: 0.9, since_date: '2024-03' }),
        take(a.id, 2, 'heavy undated', { holder: 'alice', weight: 0.9 }),
        take(a.id, 3, 'heavy newer', { holder: 'alice', weight: 0.9, since_date: '2025-06-01' }),
        take(a.id, 4, 'lighter', { holder: 'alice', weight: 0.35 }),
        take(a.id, 5, 'unresolved', { holder: 'alice', weight: 1 }),
        take(a.id, 6, 'inactive', { holder: 'alice', weight: 1, active: false }),
        take(a.id, 7, 'another holder', { holder: 'garry', weight: 1 }),
      ]);
      await engine.addTakesBatch([take(gone.id, 1, 'on a deleted page', { holder: 'alice', weight: 0.85 })]);
      await engine.addTakesBatch([take(o.id, 1, 'in another source', { holder: 'alice', weight: 0.6 })]);
      const done = { quality: 'correct' as const, resolvedBy: 'garry' };
      for (const row of [1, 2, 3, 4, 6, 7]) await engine.resolveTake(a.id, row, row === 4 ? { ...done, quality: 'incorrect' } : done);
      await engine.resolveTake(gone.id, 1, done);
      await engine.resolveTake(o.id, 1, { ...done, quality: 'partial' });
      await engine.softDeletePage('notes/top-gone');
      const rows = await engine.listTopResolvedTakesForHolder('alice');
      const ids = new Map<string, number>();
      const out = {
        alice: rows.map((r) => { ids.set(r.claim, Number(r.id)); return { ...r, id: typeof r.id }; }),
        nobody: await engine.listTopResolvedTakesForHolder('nobody'),
      };
      expect(out.alice.map((r) => r.claim)).toEqual(['heavy undated', 'heavy newer', 'heavy dated', 'on a deleted page', 'in another source', 'lighter']);
      expect(out.alice.map((r) => r.resolved_quality)).toEqual(['correct', 'correct', 'correct', 'correct', 'partial', 'incorrect']);
      expect(ids.get('heavy undated')! > ids.get('heavy dated')!).toBe(true);
      // The 25-row cap: 30 more resolved takes of one weight, each dated a day apart, keep the 25 newest.
      const bulk = await page(engine, 'notes/top-bulk');
      await engine.addTakesBatch(Array.from({ length: 30 }, (_, i) =>
        take(bulk.id, i + 1, `bulk ${i + 1}`, { holder: 'bulk', weight: 0.5, since_date: `2024-01-${String(i + 1).padStart(2, '0')}` })));
      for (let i = 1; i <= 30; i++) await engine.resolveTake(bulk.id, i, done);
      const capped = (await engine.listTopResolvedTakesForHolder('bulk')).map((r) => r.claim);
      expect(capped).toEqual(Array.from({ length: 25 }, (_, i) => `bulk ${30 - i}`));
      return { ...out, capped };
    },
  );

  parityTest(
    'listAbandonedTakes returns the five oldest active unresolved unsuperseded takes of weight 0.7 or more dated over a year ago, on any page',
    { methods: ['putPage', 'softDeletePage', 'addTakesBatch', 'resolveTake', 'listAbandonedTakes'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'abandon-other');
      const a = await page(engine, 'notes/abandon-a');
      const gone = await page(engine, 'notes/abandon-gone');
      const o = await page(engine, 'notes/abandon-o', { sourceId: 'abandon-other' });
      await engine.addTakesBatch([
        take(a.id, 1, 'month precision', { weight: 0.75, since_date: '2020-01' }),
        take(a.id, 2, 'day precision', { weight: 0.9, since_date: '2023-06-15' }),
        take(a.id, 3, 'at the stored floor', { weight: 0.7, since_date: '2019-01' }),
        take(a.id, 4, 'too light', { weight: 0.5, since_date: '2018-01' }),
        take(a.id, 5, 'recent', { weight: 0.9, since_date: '2026-10' }),
        take(a.id, 6, 'resolved', { weight: 0.9, since_date: '2018-02' }),
        take(a.id, 7, 'superseded', { weight: 0.9, since_date: '2018-03', superseded_by: 1 }),
        take(a.id, 8, 'inactive', { weight: 0.9, since_date: '2018-04', active: false }),
        take(a.id, 9, 'undated', { weight: 0.9 }),
      ]);
      await engine.addTakesBatch([take(gone.id, 1, 'on a deleted page', { weight: 1, since_date: '2021-05' })]);
      await engine.addTakesBatch([take(o.id, 1, 'in another source', { weight: 0.8, since_date: '2022-02-02' })]);
      await engine.resolveTake(a.id, 6, { quality: 'correct', outcome: true, resolvedBy: 'garry' });
      await engine.softDeletePage('notes/abandon-gone');
      const shown = async () => (await engine.listAbandonedTakes()).map((r) => ({ ...r, id: typeof r.id }));
      const first = await shown();
      expect(first.map((r) => r.claim)).toEqual(['month precision', 'on a deleted page', 'in another source', 'day precision']);
      await engine.addTakesBatch([
        take(a.id, 10, 'oldest', { weight: 0.95, since_date: '2017-07' }),
        take(a.id, 11, 'second oldest', { weight: 0.8, since_date: '2017-08-01' }),
      ]);
      const capped = await shown();
      expect(capped.map((r) => r.since_date)).toEqual(['2017-07', '2017-08-01', '2020-01', '2021-05', '2022-02-02']);
      return { first, capped };
    },
  );
});
