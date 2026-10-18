/**
 * #6495: doctor `keyword_plan`, the read-only canary for the Postgres keyword
 * arm's statement bound (`search.keyword_statement_timeout_ms`).
 *
 * Contract protected: the check is registered as an operator-resolution wave
 * check; on a fake probe it warns when the commonest term's bounded count
 * times out or spends more than half the bound, names the knob and its
 * range, says one canary is not workload coverage, and never reports a
 * timed-out count as "no matches"; it skips PGLite, small brains and a brain
 * without planner statistics; and on a real Postgres brain the probe reads
 * the commonest lexeme from pg_stats, EXPLAINs the strict count statement and
 * times the engine's own bounded count. Existing doctor coverage has no
 * keyword-arm check.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import { OPS_CHECK_NAMES } from '../src/core/doctor-categories.ts';
import { WAVE_CHECKS } from '../src/commands/doctor/wave-checks.ts';
import {
  engineKeywordPlanProbe,
  keywordPlanCheck,
  KEYWORD_PLAN_CANARY_TIMEOUT_MS,
  KEYWORD_PLAN_MIN_CHUNKS,
  type KeywordPlanCount,
  type KeywordPlanProbe,
} from '../src/commands/doctor/checks/keyword-plan.ts';
import { KEYWORD_STATEMENT_TIMEOUT_KEY } from '../src/core/postgres-engine/keyword-statement-timeout.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const postgresEngine = { kind: 'postgres' } as unknown as BrainEngine;

function fakeProbe(count: KeywordPlanCount, opts: { chunks?: number; canary?: { term: string; share: number } | null; scans?: string[] } = {}): KeywordPlanProbe & { counted: Array<[string, number]> } {
  const counted: Array<[string, number]> = [];
  return {
    counted,
    chunkEstimate: async () => opts.chunks ?? 500_000,
    canary: async () => (opts.canary === undefined ? { term: 'contract', share: 0.82 } : opts.canary),
    explain: async () => opts.scans ?? ['Seq Scan'],
    count: async (term, timeoutMs) => { counted.push([term, timeoutMs]); return count; },
  };
}

describe('keyword_plan is a registered operator wave check', () => {
  test('WAVE_CHECKS and the doctor categories carry keyword_plan', () => {
    const spec = WAVE_CHECKS.find(s => s.id === 'keyword_plan');
    expect(spec?.resolution).toBe('operator');
    expect(spec?.registration).toBe('wave');
    expect(spec?.instruction).toContain(KEYWORD_STATEMENT_TIMEOUT_KEY);
    expect(spec?.count({ outcome: 'canary_timed_out' })).toBe(1);
    expect(spec?.count({ outcome: 'canary_slow' })).toBe(1);
    expect(spec?.count({ outcome: 'ok' })).toBe(0);
    expect(OPS_CHECK_NAMES.has('keyword_plan')).toBe(true);
  });
});

describe('keyword_plan on a fake probe', () => {
  /** Every outcome names the knob with its range, says the canary is not coverage, and never calls a timed-out count "no matches". */
  const required = (message: string) => {
    expect(message).toContain(`${KEYWORD_STATEMENT_TIMEOUT_KEY} = 8000 ms (range 1000-60000)`);
    expect(message).toContain('One canary term is not workload coverage');
    expect(message.replace('A timed-out count is never "no matches".', '')).not.toMatch(/no matches/i);
  };

  test('a timed-out canary count warns, names the knob and never reads as no matches', async () => {
    const probe = fakeProbe({ outcome: 'timed_out', ms: 2003 });
    const check = await keywordPlanCheck(postgresEngine, probe);
    expect(check.status).toBe('warn');
    expect(check.details?.outcome).toBe('canary_timed_out');
    expect(check.message).toContain('"contract" (about 82.0% of chunks) did not finish a strict page count within 2003 ms');
    expect(check.message).toContain('A timed-out count is never "no matches"');
    expect(check.message).toContain('fail open to the vector arm (keyword_arm_failed)');
    expect(check.message).toContain('buys time, not a cheaper statement');
    expect(check.message).toContain('Plan: Seq Scan');
    required(check.message);
    expect(probe.counted).toEqual([['contract', KEYWORD_PLAN_CANARY_TIMEOUT_MS]]);
  });

  test('a count above half the bound warns as slow', async () => {
    const check = await keywordPlanCheck(postgresEngine, fakeProbe({ outcome: 'counted', pages: 10_001, ms: 4500 }));
    expect(check.status).toBe('warn');
    expect(check.details?.outcome).toBe('canary_slow');
    expect(check.message).toContain('took 4500 ms for a strict page count, more than half of');
    expect(check.message).toContain('A timed-out count is never "no matches"');
    required(check.message);
  });

  test('a fast count is ok and still says the canary is not coverage', async () => {
    const check = await keywordPlanCheck(postgresEngine, fakeProbe({ outcome: 'counted', pages: 1200, ms: 310 }, { scans: ['Bitmap Heap Scan', 'Bitmap Index Scan using idx_chunks_search_vector'] }));
    expect(check.status).toBe('ok');
    expect(check.details?.outcome).toBe('ok');
    expect(check.message).toContain('counted 1200 page(s) in 310 ms');
    expect(check.message).toContain('Plan: Bitmap Heap Scan, Bitmap Index Scan using idx_chunks_search_vector');
    required(check.message);
  });

  test('small brains and missing statistics are skipped with the reason, and nothing is counted', async () => {
    const small = fakeProbe({ outcome: 'timed_out', ms: 2000 }, { chunks: KEYWORD_PLAN_MIN_CHUNKS - 1 });
    const skippedSmall = await keywordPlanCheck(postgresEngine, small);
    expect(skippedSmall.status).toBe('ok');
    expect(skippedSmall.details).toMatchObject({ outcome: 'skipped', reason: 'small_brain' });
    expect(small.counted).toEqual([]);
    const noStats = fakeProbe({ outcome: 'timed_out', ms: 2000 }, { canary: null });
    const skippedStats = await keywordPlanCheck(postgresEngine, noStats);
    expect(skippedStats.status).toBe('ok');
    expect(skippedStats.details).toMatchObject({ outcome: 'skipped', reason: 'no_statistics' });
    expect(skippedStats.message).toContain('ANALYZE content_chunks');
    expect(noStats.counted).toEqual([]);
  });

  test('a probe failure reports unknown health, not ok', async () => {
    const probe = fakeProbe({ outcome: 'counted', pages: 1, ms: 1 });
    probe.canary = async () => { throw new Error('permission denied for table pg_stats'); };
    const check = await keywordPlanCheck(postgresEngine, probe);
    expect(check.status).toBe('warn');
    expect(check.details?.health).toBe('unknown');
    expect(check.message).toContain('permission denied for table pg_stats');
  });

  test('PGLite is skipped before any probe read', async () => {
    const probe = fakeProbe({ outcome: 'timed_out', ms: 2000 });
    const check = await keywordPlanCheck({ kind: 'pglite' } as unknown as BrainEngine, probe);
    expect(check).toMatchObject({ name: 'keyword_plan', status: 'ok', details: { outcome: 'skipped', reason: 'pglite' } });
    expect(probe.counted).toEqual([]);
  });
});

if (testBackends().includes('postgres')) {
  describe('keyword_plan on Postgres', () => {
    let engine: BrainEngine;
    let databaseUrl: string;
    let close: () => Promise<void>;

    beforeAll(async () => {
      ({ engine, databaseUrl, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      for (let i = 1; i <= 12; i++) {
        const slug = `notes/page-${i}`;
        const body = i <= 10 ? `renewal contract clause ${i}` : `ledgerbook entry ${i}`;
        await engine.putPage(slug, { type: 'note', title: `Page ${i}`, compiled_truth: body });
        await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
      }
      await engine.executeRaw('ANALYZE content_chunks');
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('the real probe reads the commonest lexeme, its plan and the engine\'s bounded count', async () => {
      const probe = engineKeywordPlanProbe(engine);
      expect(await probe.chunkEstimate()).toBeGreaterThanOrEqual(12);
      const canary = await probe.canary();
      expect(canary).not.toBeNull();
      expect(['contract', 'claus', 'renew']).toContain(canary!.term);
      expect(canary!.share).toBeGreaterThan(0.5);
      const scans = await probe.explain(canary!.term);
      expect(scans.length).toBeGreaterThan(0);
      const count = await probe.count(canary!.term, KEYWORD_PLAN_CANARY_TIMEOUT_MS);
      expect(count).toMatchObject({ outcome: 'counted', pages: 10 });
    });

    test('the check itself skips a small brain and names the skip', async () => {
      const check = await keywordPlanCheck(engine);
      expect(check.status).toBe('ok');
      expect(check.details).toMatchObject({ outcome: 'skipped', reason: 'small_brain' });
      expect(check.message).toContain(`${KEYWORD_STATEMENT_TIMEOUT_KEY} = 8000 ms`);
    });

    test('a count the bound cancels on a real engine is classified timed_out, never a page count of zero', async () => {
      const locker = postgres(databaseUrl, { max: 1, prepare: false });
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      let locked!: () => void;
      const lockedUp = new Promise<void>(resolve => { locked = resolve; });
      const held = locker.begin(async tx => {
        await tx.unsafe('LOCK TABLE content_chunks IN ACCESS EXCLUSIVE MODE');
        locked();
        await released;
      }).catch(() => {});
      await lockedUp;
      try {
        const timed = await engineKeywordPlanProbe(engine).count('contract', 1000);
        expect(timed.outcome).toBe('timed_out');
        expect(timed.ms).toBeGreaterThanOrEqual(900);
        expect(timed.ms).toBeLessThan(4000);
      } finally {
        release();
        await held;
        await locker.end({ timeout: 5 });
      }
      expect(await engineKeywordPlanProbe(engine).count('contract', 1000)).toMatchObject({ outcome: 'counted', pages: 10 });
    }, 30_000);
  });
}
