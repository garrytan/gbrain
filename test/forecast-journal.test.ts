/**
 * W7 (wave 4b), slices 2 and 3: the private forecast journal and the grouped
 * scorecard. Each cell runs on PGLite and, with DATABASE_URL, on Postgres.
 *
 * Protects:
 *   - every active take that is not a fact is a prediction, in one of four
 *     states: resolved, overdue (past a current horizon, unresolved), open, or
 *     undated (no current horizon); the totals keep the unresolved denominator;
 *   - prediction time comes from the belief ledger's first live take.asserted
 *     event and is certified only where coverage certifies it (a managed
 *     source); otherwise it is since_date, labelled uncertified;
 *   - takes_scorecard {group_by} gives trusted local callers Beta-shrunk
 *     accuracy, a Wilson interval, Brier and Brier skill, recency-weighted
 *     accuracy, citations and low_n per holder or source; a remote caller that
 *     passes group_by gets a typed refusal; without group_by the output is
 *     unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { readForecastJournal, scorecardGroups } from '../src/core/forecast-journal.ts';
import { scanStatedHorizons } from '../src/core/takes-horizon.ts';
import { disableBeliefLedger } from '../src/core/belief/coverage.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';

const AS_OF = new Date('2026-10-16T00:00:00Z');
const takesPage = (takes: Array<{ claim: string; who: string; weight?: string; since?: string }>) => beliefPage({ takes });

async function resolve(b: BeliefBrain, claim: string, quality: 'correct' | 'incorrect' | 'partial', at = '2025-03-01T00:00:00Z', source: string | null = 'notes/2025-03-01-update') {
  await b.engine.executeRaw(
    `UPDATE takes SET resolved_at = $2::timestamptz, resolved_quality = $3, resolved_outcome = CASE $3 WHEN 'correct' THEN true WHEN 'incorrect' THEN false END,
       resolved_by = 'owner', resolved_source = $4 WHERE claim = $1`, [claim, at, quality, source]);
}

const ctx = (b: BeliefBrain, remote: boolean) => ({ ...b.ctx, remote,
  ...(remote ? { auth: { token: 't', clientId: 'c1', scopes: ['read'], sourceId: b.sourceId } } : {}) }) as unknown as OperationContext;

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`forecast journal (${engineCase.name})`, () => {
    test('states, filters and the unresolved denominator', () => beliefBrain(async b => {
      await b.put('companies/acme-example', takesPage([{ claim: 'Acme-example will reach $5M ARR by the end of 2024', who: 'alice-example', weight: '0.8', since: '2023-02' }]));
      await b.put('companies/bluefin-example', takesPage([{ claim: 'Bluefin-example will open a Berlin office by Q2 2025', who: 'bob-example', weight: '0.6', since: '2023-06' }]));
      await b.put('companies/cobalt-example', takesPage([{ claim: 'Cobalt-example will list by the end of 2030', who: 'alice-example', weight: '0.3', since: '2024-01' }]));
      await b.put('companies/dune-example', takesPage([{ claim: 'Dune-example has the strongest team in its market', who: 'bob-example', since: '2024-02' }]));
      await resolve(b, 'Acme-example will reach $5M ARR by the end of 2024', 'correct');
      await scanStatedHorizons(b.engine, { apply: true, sourceId: b.sourceId });
      const bluefinId = (await b.engine.executeRaw<{ id: number }>(`SELECT id FROM takes WHERE claim LIKE 'Bluefin-example%'`))[0]!.id;
      for (const [model, at, verdict, confidence] of [['anthropic:claude-opus-5-5', '2026-10-01T00:00:00Z', 'unresolvable', 0.4], ['openai:some-unmeasured-model', '2026-10-10T00:00:00Z', 'incorrect', 0.97]] as const) {
        await b.engine.executeRaw(`INSERT INTO take_grade_cache (take_id, prompt_version, judge_model_id, evidence_signature, graded_at, verdict, confidence)
          VALUES ($1, 'hybrid-evidence-v2', $2, 'sig', $3::timestamptz, $4, $5)`, [bluefinId, model, at, verdict, confidence]);
      }

      const j = await readForecastJournal(b.engine, { sourceId: b.sourceId, asOf: AS_OF });
      expect(j.totals).toEqual({ predictions: 4, resolved: 1, unresolved: 3, open: 1, overdue: 1, undated: 1, certified_prediction_times: 0 });
      const by = Object.fromEntries(j.entries.map(e => [e.page_slug, e]));
      expect(by['companies/acme-example']).toMatchObject({ state: 'resolved', holder: 'alice-example', weight: 0.8,
        horizon: { date: '2024-12-31', basis: 'stated', current: true },
        resolution: { quality: 'correct', resolved_by: 'owner', resolved_source: 'notes/2025-03-01-update' },
        prediction: { at: '2023-02', basis: 'since_date', certified: false } });
      expect(by['companies/bluefin-example']).toMatchObject({ state: 'overdue', horizon: { date: '2025-06-30' }, resolution: null,
        grade: { verdict: 'incorrect', confidence: 0.97, applied: false, judge_model_id: 'openai:some-unmeasured-model', judge_measured: false, graded_at: '2026-10-10T00:00:00.000Z' } });
      expect(by['companies/acme-example']!.grade).toBeNull();
      expect(by['companies/cobalt-example']).toMatchObject({ state: 'open', horizon: { date: '2030-12-31' } });
      expect(by['companies/dune-example']).toMatchObject({ state: 'undated', horizon: null });

      expect((await readForecastJournal(b.engine, { sourceId: b.sourceId, asOf: AS_OF, holder: 'bob-example' })).entries.map(e => e.page_slug).sort())
        .toEqual(['companies/bluefin-example', 'companies/dune-example']);
      expect((await readForecastJournal(b.engine, { sourceId: b.sourceId, asOf: AS_OF, about: 'companies/cobalt' })).entries.map(e => e.page_slug))
        .toEqual(['companies/cobalt-example']);
      const overdue = await readForecastJournal(b.engine, { sourceId: b.sourceId, asOf: AS_OF, state: 'overdue' });
      expect(overdue.entries.map(e => e.page_slug)).toEqual(['companies/bluefin-example']);
      expect(overdue.totals.predictions).toBe(4);
      const limited = await readForecastJournal(b.engine, { sourceId: b.sourceId, asOf: AS_OF, limit: 1 });
      expect([limited.entries.length, limited.totals.predictions]).toEqual([1, 4]);
    }, { databaseUrl: engineCase.databaseUrl, enable: false }), 120_000);

    test('a managed source certifies the recorded prediction time; a take that predates the ledger falls back to since_date', () => beliefBrain(async b => {
      await b.put('companies/acme-example', takesPage([{ claim: 'Acme-example will reach $9M ARR by the end of 2027', who: 'alice-example', since: '2026-09' }]));
      const created = (await b.events()).find(e => e.slug === 'companies/acme-example' && e.event_type === 'page.published' && e.value?.revision_before == null)!;
      const j = await readForecastJournal(b.engine, { sourceId: b.sourceId, asOf: AS_OF });
      const byClaim = Object.fromEntries(j.entries.map(e => [e.claim, e]));
      expect(byClaim['Acme-example will reach $9M ARR by the end of 2027']!.prediction).toEqual({ at: new Date(created.recorded_at).toISOString(), basis: 'recorded', certified: true });
      expect(byClaim['Old-example will merge by the end of 2026']!.prediction).toEqual({ at: '2025-01', basis: 'since_date', certified: false });
      expect(j.totals.certified_prediction_times).toBe(1);
    }, { managed: true, databaseUrl: engineCase.databaseUrl,
      setup: async b => { await b.put('companies/old-example', takesPage([{ claim: 'Old-example will merge by the end of 2026', who: 'bob-example', since: '2025-01' }])); } }), 180_000);

    test('an unmanaged source records the prediction time but does not certify it; a take added later gets its own take.asserted time', () => beliefBrain(async b => {
      const first = { claim: 'Acme-example will hire 50 people by Q4 2027', who: 'alice-example', since: '2026-09' };
      await b.put('companies/acme-example', takesPage([first]));
      const created = (await b.events()).find(e => e.event_type === 'page.published')!;
      const mark = await b.lastId();
      await b.put('companies/acme-example', takesPage([first, { claim: 'Acme-example will open a second office by 2028', who: 'bob-example', since: '2026-10' }]));
      const asserted = (await b.events(mark)).filter(e => e.event_type === 'take.asserted');
      expect(asserted).toHaveLength(1);
      const byClaim = Object.fromEntries((await readForecastJournal(b.engine, { sourceId: b.sourceId, asOf: AS_OF })).entries.map(e => [e.claim, e]));
      expect(byClaim[first.claim]!.prediction).toEqual({ at: new Date(created.recorded_at).toISOString(), basis: 'recorded', certified: false });
      expect(byClaim['Acme-example will open a second office by 2028']!.prediction).toEqual({ at: new Date(asserted[0]!.recorded_at).toISOString(), basis: 'recorded', certified: false });
    }, { databaseUrl: engineCase.databaseUrl }), 120_000);

    test('a coverage stop after the page was created drops the snapshot time: the take falls back to since_date', () => beliefBrain(async b => {
      await b.put('companies/acme-example', takesPage([{ claim: 'Acme-example will hire 50 people by Q4 2027', who: 'alice-example', since: '2026-09' }]));
      await disableBeliefLedger(b.engine, b.sourceId);
      await b.enable();
      const [e] = (await readForecastJournal(b.engine, { sourceId: b.sourceId, asOf: AS_OF })).entries;
      expect(e!.prediction).toEqual({ at: '2026-09', basis: 'since_date', certified: false });
    }, { databaseUrl: engineCase.databaseUrl }), 120_000);

    test('grouped scorecard: shrunk accuracy, interval, Brier skill, recency, citations, low_n; remote group_by is refused', () => beliefBrain(async b => {
      const rows: Array<[string, string, string, 'correct' | 'incorrect', string, string | null]> = [];
      for (let i = 0; i < 12; i++) rows.push([`companies/a${i}-example`, 'alice-example', i < 10 ? '0.9' : '0.6', i < 10 ? 'correct' : 'incorrect', i < 6 ? '2026-06-01T00:00:00Z' : '2023-06-01T00:00:00Z', i < 3 ? null : 'notes/evidence']);
      for (let i = 0; i < 4; i++) rows.push([`companies/b${i}-example`, 'bob-example', '0.7', i < 1 ? 'correct' : 'incorrect', '2025-06-01T00:00:00Z', 'notes/evidence']);
      for (const [slug, who, weight, quality, at, src] of rows) {
        const claim = `${slug.slice(10, -8)} will grow by the end of 2024`;
        await b.put(slug, takesPage([{ claim, who, weight, since: '2023-01' }]));
        await resolve(b, claim, quality, at, src);
      }
      await b.put('companies/open-example', takesPage([{ claim: 'open will grow by the end of 2030', who: 'bob-example', since: '2024-01' }]));
      await scanStatedHorizons(b.engine, { apply: true, sourceId: b.sourceId });

      const groups = await scorecardGroups(b.engine, { groupBy: 'holder', minN: 10, sourceId: b.sourceId, asOf: AS_OF });
      const alice = groups.find(g => g.key === 'alice-example')!;
      const bob = groups.find(g => g.key === 'bob-example')!;
      expect(alice).toMatchObject({ n: 12, correct: 10, incorrect: 2, low_n: false, citations: 9, unresolved: 0 });
      expect(bob).toMatchObject({ n: 4, correct: 1, incorrect: 3, low_n: true, citations: 4, unresolved: 1, open: 1, overdue: 0 });
      expect(alice.accuracy).toBeCloseTo(10 / 12, 6);
      const pooled = 11 / 16;
      expect(alice.accuracy_shrunk).toBeCloseTo((10 + 10 * pooled) / (12 + 10), 6);
      expect(bob.accuracy_shrunk).toBeCloseTo((1 + 10 * pooled) / (4 + 10), 6);
      expect(bob.accuracy_shrunk!).toBeGreaterThan(bob.accuracy!);
      expect(alice.accuracy_wilson95![0]).toBeLessThan(alice.accuracy!);
      expect(alice.accuracy_wilson95![1]).toBeGreaterThan(alice.accuracy!);
      const aliceBrier = (10 * (0.9 - 1) ** 2 + 2 * (0.6 - 0) ** 2) / 12;
      expect(alice.brier).toBeCloseTo(aliceBrier, 6);
      expect(alice.brier_skill).toBeCloseTo(1 - aliceBrier / ((10 / 12) * (2 / 12)), 6);
      expect(alice.accuracy_recent!).toBeGreaterThan(alice.accuracy!);
      expect(groups.map(g => g.key)).toEqual(['alice-example', 'bob-example']);
      expect((await scorecardGroups(b.engine, { groupBy: 'source', minN: 10, sourceId: b.sourceId, asOf: AS_OF })).map(g => [g.key, g.n])).toEqual([[b.sourceId, 16]]);

      const op = operationsByName.takes_scorecard!;
      const plain = JSON.stringify(await op.handler(ctx(b, false), {}));
      const grouped = await op.handler(ctx(b, false), { group_by: 'holder', min_n: 10 }) as Record<string, unknown>;
      expect(JSON.stringify({ ...grouped, groups: undefined, journal: undefined })).toBe(plain);
      expect((grouped.groups as Array<{ key: string }>).map(g => g.key)).toEqual(['alice-example', 'bob-example']);
      expect(grouped.journal).toMatchObject({ predictions: 17, resolved: 16, unresolved: 1 });
      await expect(op.handler(ctx(b, true), { group_by: 'holder' })).rejects.toMatchObject({ code: 'scorecard_group_by_local_only' });
      await expect(op.handler(ctx(b, true), { min_n: 5 })).rejects.toMatchObject({ code: 'scorecard_group_by_local_only' });
      await expect(op.handler(ctx(b, false), { group_by: 'domain' })).rejects.toMatchObject({ code: 'invalid_params' });
      expect(JSON.stringify(await op.handler(ctx(b, true), {}))).not.toContain('groups');
    }, { databaseUrl: engineCase.databaseUrl, enable: false }), 180_000);
  });
}
