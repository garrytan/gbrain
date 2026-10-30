/**
 * grade_takes work window (src/core/cycle/grade-takes.ts, listTakes in src/core/engine-sql/takes.ts).
 *
 * Protects: the phase reads unresolved takes oldest-first, as documented; takes
 * too recent to grade (an ISO since_date after the min-age cutoff, or none) are
 * left out in SQL so they cannot fill the window; takes with no verdict for the
 * current prompt and judge come before graded ones, so with auto-resolve off a
 * graded take leaves the window and the next pass grades the ones behind it;
 * a brain smaller than the window grades exactly the same takes as before.
 * Fails when: the window sorts newest-first, 50 too-recent takes block all
 * grading, or the same graded takes hold the window every pass while older
 * ungraded takes are never judged.
 * Why new: grade-takes.test.ts drives a mocked listTakes, so no test ran the
 * window query on a real engine.
 * Runs on PGLite, and on Postgres with a safe DATABASE_URL (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine, Take } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { runPhaseGradeTakes, type EvidenceRetrieverFn, type JudgeFn } from '../src/core/cycle/grade-takes.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const monthsAgo = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() - n); return d.toISOString().slice(0, 10); };

for (const kind of testBackends()) {
  describe(`grade_takes window (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let n = 0;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM take_grade_cache');
      await engine.executeRaw('DELETE FROM takes');
    });

    const seed = async (rows: Array<{ claim: string; since: string | undefined }>) => {
      const page = await engine.putPage(`notes/grade-window-${++n}`, { type: 'note', title: 'Grade window', compiled_truth: 'Seed page.', timeline: '' });
      await engine.addTakesBatch(rows.map((r, i) => ({ page_id: page.id, row_num: i + 1, claim: r.claim, kind: 'bet' as const, holder: 'alice-example', weight: 0.6,
        ...(r.since ? { since_date: r.since } : {}) })));
    };
    const ctx = (): OperationContext => ({ engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, sourceId: 'default' });
    const pass = async (takeLimit: number) => {
      const judged: string[] = [];
      const evidence: string[] = [];
      const judge: JudgeFn = async ({ take }: { take: Take }) => { judged.push(take.claim); return { verdict: 'unresolvable', confidence: 0.5, reasoning: 'stub' }; };
      const evidenceRetriever: EvidenceRetrieverFn = async (take: Take) => { evidence.push(take.claim); return `evidence for ${take.claim}`; };
      const result = await runPhaseGradeTakes(ctx(), { judge, evidenceRetriever, takeLimit, minAgeMonths: 6, model: 'anthropic:claude-sonnet-4-6' });
      return { judged, evidence, details: result.details as Record<string, unknown> };
    };

    test('too-recent takes do not fill the window, and it reads oldest-first', async () => {
      await seed([
        { claim: 'recent-1', since: monthsAgo(1) }, { claim: 'recent-2', since: monthsAgo(1) }, { claim: 'recent-3', since: monthsAgo(2) },
        { claim: 'undated', since: undefined }, { claim: 'old-2021', since: '2021-03' }, { claim: 'old-2020', since: '2020-01-01' },
      ]);
      const first = await pass(3);
      expect(first.judged).toEqual(['old-2020', 'old-2021']);
      expect(first.evidence).toEqual(['old-2020', 'old-2021']);
    });

    test('with auto-resolve off, graded takes leave the window and the next pass grades the takes behind them', async () => {
      await seed(['2016', '2017', '2018', '2019', '2020'].map(y => ({ claim: `take-${y}`, since: `${y}-06-01` })));
      expect((await pass(3)).judged).toEqual(['take-2016', 'take-2017', 'take-2018']);
      const second = await pass(3);
      expect(second.judged).toEqual(['take-2019', 'take-2020']);
      const third = await pass(3);
      expect(third.judged).toEqual([]);
      expect(third.details.cache_hits).toBe(3);
    });

    test('a brain smaller than the window grades every eligible take once', async () => {
      await seed([{ claim: 'a', since: '2019-01-01' }, { claim: 'b', since: '2018-01-01' }, { claim: 'c', since: '2020-01' }, { claim: 'young', since: monthsAgo(1) }]);
      expect((await pass(50)).judged.sort()).toEqual(['a', 'b', 'c']);
      const again = await pass(50);
      expect(again.judged).toEqual([]);
      expect(again.details.cache_hits).toBe(3);
    });
  });
}
