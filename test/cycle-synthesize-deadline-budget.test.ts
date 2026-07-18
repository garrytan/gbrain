/**
 * #2781 follow-up — synthesize budgets its fan-out and its SEQUENTIAL
 * per-child waits from the remaining parent-job time. Without the
 * per-wait recompute, N children accumulate N × subagent_wait_timeout_ms
 * past any parent budget (patterns' single-wait clamp can't help here).
 *
 * Layers mirror test/cycle-patterns-deadline-budget.test.ts:
 *   1. Unit tests on `remainingChildBudgetMs` (the per-iteration primitive).
 *   2. Structural pins on the synthesize wiring.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import {
  remainingChildBudgetMs,
  CYCLE_DEADLINE_RESERVE_MS,
} from '../src/core/cycle/deadline-budget.ts';

describe('remainingChildBudgetMs', () => {
  const now = 1_000_000_000_000;

  test('null deadline → null (direct `gbrain dream` back-compat)', () => {
    expect(remainingChildBudgetMs(null, now)).toBeNull();
    expect(remainingChildBudgetMs(undefined, now)).toBeNull();
  });

  test('subtracts the reserve from the remaining time', () => {
    const deadline = now + 10 * 60 * 1000;
    expect(remainingChildBudgetMs(deadline, now)).toBe(10 * 60 * 1000 - CYCLE_DEADLINE_RESERVE_MS);
  });

  test('goes non-positive once the reserve is breached (callers stop waiting)', () => {
    expect(remainingChildBudgetMs(now + CYCLE_DEADLINE_RESERVE_MS, now)).toBe(0);
    expect(remainingChildBudgetMs(now - 1000, now)).toBeLessThan(0);
  });
});

describe('synthesize deadline wiring (structural)', () => {
  const synthSrc = readFileSync(new URL('../src/core/cycle/synthesize.ts', import.meta.url), 'utf-8');
  const cycleSrc = readFileSync(new URL('../src/core/cycle.ts', import.meta.url), 'utf-8');
  const patternsSrc = readFileSync(new URL('../src/core/cycle/patterns.ts', import.meta.url), 'utf-8');

  test('runCycle forwards deadlineAtMs to the synthesize phase', () => {
    // Both subagent-spawning phases receive the deadline (patterns pinned
    // in its own test file; this pins the synthesize call site).
    const callSite = cycleSrc.indexOf('runPhaseSynthesize(engine, {');
    expect(callSite).toBeGreaterThan(0);
    const callSlice = cycleSrc.slice(callSite, callSite + 600);
    expect(callSlice).toContain('deadlineAtMs: opts.deadlineAtMs ?? null');
  });

  test('pre-fanout gate skips honestly before submitting any Sonnet work', () => {
    expect(synthSrc).toContain('insufficient_cycle_budget');
    // Gate sits after the verdict loop (which consumes wall-clock) and
    // before the fan-out submit loop.
    const gateIdx = synthSrc.indexOf('preFanoutBudgetMs');
    const fanoutIdx = synthSrc.indexOf('const queue = new MinionQueue(engine)');
    expect(gateIdx).toBeGreaterThan(0);
    expect(fanoutIdx).toBeGreaterThan(gateIdx);
  });

  test('per-child submit clamps timeout_ms to the remaining budget', () => {
    expect(synthSrc).toContain('timeout_ms: childTimeoutMs');
    expect(synthSrc).not.toContain('timeout_ms: config.subagentTimeoutMs');
  });

  test('sequential wait loop recomputes the remaining budget EVERY iteration', () => {
    // The recompute call must be INSIDE the `for (const jobId of childIds)`
    // loop body — a single pre-loop computation is exactly the bug.
    const loopIdx = synthSrc.indexOf('for (const jobId of childIds)');
    expect(loopIdx).toBeGreaterThan(0);
    const loopSlice = synthSrc.slice(loopIdx, loopIdx + 800);
    expect(loopSlice).toContain('remainingChildBudgetMs(opts.deadlineAtMs, Date.now())');
    expect(synthSrc).toContain('timeoutMs: waitTimeoutMs');
    expect(synthSrc).not.toContain('timeoutMs: config.subagentWaitTimeoutMs');
  });

  test('exhausted budget cancels un-terminal children but keeps real terminal statuses', () => {
    const loopIdx = synthSrc.indexOf('for (const jobId of childIds)');
    const loopSlice = synthSrc.slice(loopIdx, loopIdx + 1600);
    expect(loopSlice).toContain('queue.getJob(jobId)');
    expect(loopSlice).toContain('queue.cancelJob(jobId)');
  });

  test('wait-timeout path cancels the child (queued child can outlive the clamp)', () => {
    // Two cancel sites in the wait loop: budget-exhausted and TimeoutError.
    const matches = synthSrc.match(/queue\.cancelJob\(jobId\)/g) ?? [];
    expect(matches.length).toBe(2);
  });

  test('shared helpers live in deadline-budget.ts (no patterns↔synthesize cycle)', () => {
    expect(synthSrc).toContain("from './deadline-budget.ts'");
    expect(patternsSrc).toContain("from './deadline-budget.ts'");
    // patterns must NOT re-define the helpers it now imports.
    expect(patternsSrc).not.toContain('export function clampSubagentBudgets');
    expect(patternsSrc).not.toContain('export const CYCLE_DEADLINE_RESERVE_MS');
  });
});
