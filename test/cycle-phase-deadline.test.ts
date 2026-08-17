/**
 * gbrain#4168 — phase deadlines must clamp to the owning job's absolute
 * deadline (claim-time timeout_at), or the clean partial-exit path is dead
 * code: at the default installed-daemon interval the autopilot-cycle timeout
 * floor (1_800_000ms) EQUALS propose_takes' 30-min phase default, and since
 * the phase starts after earlier phases, phase-elapsed always trailed
 * job-elapsed — cycles dead-lettered instead of banking partial work.
 *
 * Red-on-master proof: on pre-fix code `deadlineAtMs` is an unknown option
 * (silently ignored), so the phase runs the full page/take loop and the
 * deadline_hit assertions below fail AT THE ASSERTION.
 */

import { describe, test, expect } from 'bun:test';
import {
  effectivePhaseDeadlineMs,
  CYCLE_DEADLINE_RESERVE_MS,
} from '../src/core/cycle/base-phase.ts';
import { CYCLE_DEADLINE_RESERVE_MS as RESERVE_VIA_PATTERNS } from '../src/core/cycle/patterns.ts';
import { runPhaseProposeTakes, type ProposeTakesExtractor } from '../src/core/cycle/propose-takes.ts';
import { runPhaseGradeTakes } from '../src/core/cycle/grade-takes.ts';
import { runPhaseCalibrationProfile } from '../src/core/cycle/calibration-profile.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function buildCtx(engine: BrainEngine): OperationContext {
  return {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

const PAGE_SQL_MARKER = 'SELECT slug, source_id, compiled_truth';

function proposeEngine(pageCount: number): BrainEngine {
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    slug: `wiki/p${i}`,
    source_id: 'default',
    compiled_truth: `page ${i} prose long enough to be processed by the loop.`,
  }));
  return {
    kind: 'pglite',
    async executeRaw<T>(sql: string): Promise<T[]> {
      if (sql.includes(PAGE_SQL_MARKER)) return pages as T[];
      return [] as T[];
    },
    async getConfig() { return null; },
  } as unknown as BrainEngine;
}

describe('effectivePhaseDeadlineMs (gbrain#4168)', () => {
  const NOW = 1_755_300_000_000;
  const DEFAULT = 30 * 60 * 1000;

  test('no job deadline → phase default', () => {
    expect(effectivePhaseDeadlineMs(DEFAULT, null, NOW)).toBe(DEFAULT);
    expect(effectivePhaseDeadlineMs(DEFAULT, undefined, NOW)).toBe(DEFAULT);
  });

  test('far job deadline → phase default (clamp is a no-op)', () => {
    const deadlineAt = NOW + 2 * 60 * 60 * 1000; // 2h out
    expect(effectivePhaseDeadlineMs(DEFAULT, deadlineAt, NOW)).toBe(DEFAULT);
  });

  test('near job deadline → clamped strictly below remaining budget by the reserve', () => {
    const deadlineAt = NOW + 10 * 60 * 1000; // 10 min of job budget left
    const effective = effectivePhaseDeadlineMs(DEFAULT, deadlineAt, NOW);
    expect(effective).toBe(10 * 60 * 1000 - CYCLE_DEADLINE_RESERVE_MS);
    // The property the bug violated: effective phase deadline < remaining job budget.
    expect(effective).toBeLessThan(deadlineAt - NOW);
  });

  test('the exact pre-fix trap: job floor == phase default still clamps below the floor', () => {
    const deadlineAt = NOW + 1_800_000; // autopilot-cycle timeout floor
    const effective = effectivePhaseDeadlineMs(DEFAULT, deadlineAt, NOW);
    expect(effective).toBe(1_800_000 - CYCLE_DEADLINE_RESERVE_MS);
    expect(effective).toBeLessThan(1_800_000);
  });

  test('job budget already inside the reserve → 0, never negative or unlimited', () => {
    expect(effectivePhaseDeadlineMs(DEFAULT, NOW + CYCLE_DEADLINE_RESERVE_MS - 1, NOW)).toBe(0);
    expect(effectivePhaseDeadlineMs(DEFAULT, NOW - 1000, NOW)).toBe(0);
  });

  test('patterns.ts re-export stays the same constant (back-compat)', () => {
    expect(RESERVE_VIA_PATTERNS).toBe(CYCLE_DEADLINE_RESERVE_MS);
  });
});

describe('phases consume deadlineAtMs (red on master: option was ignored)', () => {
  test('propose_takes with the job budget inside the reserve exits with deadline_hit before any page', async () => {
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => { extractorCalls++; return []; };
    const result = await runPhaseProposeTakes(buildCtx(proposeEngine(3)), {
      extractor,
      deadlineAtMs: Date.now() - 1, // already past — worst case
    });
    const details = result.details as Record<string, unknown>;
    expect(details.deadline_hit).toBe(true);
    expect(details.pages_scanned).toBe(0);
    expect(extractorCalls).toBe(0);
  });

  test('grade_takes with the job budget inside the reserve exits with deadline_hit before any take', async () => {
    let judgeCalls = 0;
    const engine = {
      kind: 'pglite',
      async listTakes() {
        return [{ id: 't1', claim_text: 'c', since_date: '2020-01-01', holder: 'h', weight: 0.5 }];
      },
      async executeRaw<T>(): Promise<T[]> { return [] as T[]; },
      async getConfig() { return null; },
    } as unknown as BrainEngine;
    const result = await runPhaseGradeTakes(buildCtx(engine), {
      judge: (async () => { judgeCalls++; return { verdict: 'right', confidence: 0.9, rationale: 'r' }; }) as never,
      deadlineAtMs: Date.now() - 1,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.deadline_hit).toBe(true);
    expect(details.takes_scanned).toBe(0);
    expect(judgeCalls).toBe(0);
    expect(result.status).toBe('warn');
  });

  test('calibration_profile with the job budget inside the reserve skips cleanly (warn + deadline_hit)', async () => {
    const engine = {
      kind: 'pglite',
      async executeRaw<T>(): Promise<T[]> { return [] as T[]; },
      async getConfig() { return null; },
    } as unknown as BrainEngine;
    const result = await runPhaseCalibrationProfile(buildCtx(engine), {
      deadlineAtMs: Date.now() - 1,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.deadline_hit).toBe(true);
    expect(result.status).toBe('warn');
    expect(details.profile_written).toBe(false);
  });

  test('grade_takes breaks MID-LOOP on the deadline: partial banked, warn status (review gap G5)', async () => {
    let judgeCalls = 0;
    const inserts: string[] = [];
    const engine = {
      kind: 'pglite',
      async listTakes() {
        return [1, 2, 3].map(i => ({ id: i, row_num: i, page_slug: `p/${i}`, claim: `c${i}`, holder: 'h', weight: 0.5, since_date: '2020-01-01' }));
      },
      async executeRaw<T>(sql: string): Promise<T[]> {
        if (sql.includes('INSERT')) inserts.push(sql);
        return [] as T[];
      },
      async getConfig() { return null; },
    } as unknown as BrainEngine;
    const result = await runPhaseGradeTakes(buildCtx(engine), {
      judge: (async () => {
        judgeCalls++;
        await new Promise(r => setTimeout(r, 40));
        return { verdict: 'right', confidence: 0.9, rationale: 'r' };
      }) as never,
      evidenceRetriever: (async () => 'some evidence') as never,
      deadlineMs: 15, // fires after the first (slow) take, before the second
    });
    const details = result.details as Record<string, unknown>;
    expect(details.deadline_hit).toBe(true);
    expect(Number(details.takes_scanned)).toBeLessThan(3);
    expect(judgeCalls).toBeLessThan(3); // did NOT run the full list
    expect(judgeCalls).toBeGreaterThan(0); // …but banked real work first
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('[deadline hit — partial]');
  });

  test('no deadlineAtMs → phases run normally (interactive CLI unaffected)', async () => {
    const extractor: ProposeTakesExtractor = async () => [];
    const result = await runPhaseProposeTakes(buildCtx(proposeEngine(2)), { extractor });
    const details = result.details as Record<string, unknown>;
    expect(details.deadline_hit).toBe(false);
    expect(details.pages_scanned).toBe(2);
  });
});
