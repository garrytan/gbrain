/**
 * #2781 — patterns phase budgets its subagent from the REMAINING parent-job
 * time instead of a fixed 30/35-min default that can exceed any
 * interval-derived cycle budget and dead-letter the whole cycle mid-phase.
 *
 * Layers:
 *   1. Unit tests on the exported pure `clampSubagentBudgets`.
 *   2. A real-queue check that `claim` stamps `timeout_at` (the DB ground
 *      truth `deadlineAtMs` derives from) and leaves it null when the job
 *      has no per-job timeout.
 *   3. Structural assertions pinning the wiring: worker → context →
 *      handler → runCycle → patterns (matches the house style of
 *      test/cycle-patterns.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  clampSubagentBudgets,
  CYCLE_DEADLINE_RESERVE_MS,
  MIN_PATTERNS_SUBAGENT_BUDGET_MS,
} from '../src/core/cycle/patterns.ts';

const CONFIG = {
  subagentTimeoutMs: 30 * 60 * 1000,
  subagentWaitTimeoutMs: 35 * 60 * 1000,
};

describe('clampSubagentBudgets', () => {
  const now = 1_000_000_000_000; // fixed epoch ms; the function takes nowMs explicitly

  test('null deadline → config passthrough (direct `gbrain dream` back-compat)', () => {
    expect(clampSubagentBudgets(CONFIG, null, now)).toEqual({
      timeoutMs: CONFIG.subagentTimeoutMs,
      waitTimeoutMs: CONFIG.subagentWaitTimeoutMs,
    });
    expect(clampSubagentBudgets(CONFIG, undefined, now)).toEqual({
      timeoutMs: CONFIG.subagentTimeoutMs,
      waitTimeoutMs: CONFIG.subagentWaitTimeoutMs,
    });
  });

  test('deadline far away → config values win (no clamping)', () => {
    const deadline = now + 2 * 60 * 60 * 1000; // 2h out
    expect(clampSubagentBudgets(CONFIG, deadline, now)).toEqual({
      timeoutMs: CONFIG.subagentTimeoutMs,
      waitTimeoutMs: CONFIG.subagentWaitTimeoutMs,
    });
  });

  test('deadline inside config window → BOTH timeouts clamp to the same child budget', () => {
    const deadline = now + 10 * 60 * 1000; // 10 min out
    const childBudget = deadline - CYCLE_DEADLINE_RESERVE_MS - now; // 9 min
    const budgets = clampSubagentBudgets(CONFIG, deadline, now);
    expect(budgets).toEqual({ timeoutMs: childBudget, waitTimeoutMs: childBudget });
    // The child's own kill switch never outlives the parent budget.
    expect(budgets!.timeoutMs).toBeLessThanOrEqual(deadline - now);
  });

  test('remaining budget below minimum → null (caller skips, no submit)', () => {
    const deadline = now + CYCLE_DEADLINE_RESERVE_MS + MIN_PATTERNS_SUBAGENT_BUDGET_MS - 1;
    expect(clampSubagentBudgets(CONFIG, deadline, now)).toBeNull();
  });

  test('boundary: exactly the minimum budget → submit allowed', () => {
    const deadline = now + CYCLE_DEADLINE_RESERVE_MS + MIN_PATTERNS_SUBAGENT_BUDGET_MS;
    expect(clampSubagentBudgets(CONFIG, deadline, now)).toEqual({
      timeoutMs: MIN_PATTERNS_SUBAGENT_BUDGET_MS,
      waitTimeoutMs: MIN_PATTERNS_SUBAGENT_BUDGET_MS,
    });
  });

  test('deadline already past → null, never a negative timeout', () => {
    expect(clampSubagentBudgets(CONFIG, now - 1000, now)).toBeNull();
  });
});

describe('claim stamps timeout_at (deadlineAtMs ground truth)', () => {
  let engine: PGLiteEngine;
  let queue: MinionQueue;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' }); // in-memory
    await engine.initSchema();
    queue = new MinionQueue(engine);
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('job with timeout_ms → claim sets timeout_at ≈ now + timeout_ms', async () => {
    const before = Date.now();
    await queue.add('sync', {}, { timeout_ms: 600_000 });
    const claimed = await queue.claim('tok-dl-1', 30000, 'default', ['sync']);
    const after = Date.now();
    expect(claimed).not.toBeNull();
    expect(claimed!.timeout_at).not.toBeNull();
    const at = claimed!.timeout_at!.getTime();
    expect(at).toBeGreaterThanOrEqual(before + 600_000 - 5_000);
    expect(at).toBeLessThanOrEqual(after + 600_000 + 5_000);
  });

  test('job without timeout_ms and no handler default → timeout_at stays null', async () => {
    // 'sync' is not in the long-handler default set, so no stamp either way.
    await queue.add('sync', { which: 'no-timeout' });
    // Drain the possibly-remaining job from the prior test first.
    let claimed = await queue.claim('tok-dl-2', 30000, 'default', ['sync']);
    while (claimed && claimed.timeout_ms != null) {
      claimed = await queue.claim('tok-dl-2', 30000, 'default', ['sync']);
    }
    expect(claimed).not.toBeNull();
    expect(claimed!.timeout_ms).toBeNull();
    expect(claimed!.timeout_at).toBeNull();
  });
});

describe('deadline plumbing wiring (structural)', () => {
  const workerSrc = readFileSync(new URL('../src/core/minions/worker.ts', import.meta.url), 'utf-8');
  const jobsSrc = readFileSync(new URL('../src/commands/jobs.ts', import.meta.url), 'utf-8');
  const cycleSrc = readFileSync(new URL('../src/core/cycle.ts', import.meta.url), 'utf-8');
  const patternsSrc = readFileSync(new URL('../src/core/cycle/patterns.ts', import.meta.url), 'utf-8');

  test('worker exposes deadlineAtMs from the claim-time timeout_at stamp', () => {
    expect(workerSrc).toContain('deadlineAtMs: job.timeout_at != null ? job.timeout_at.getTime() : null');
  });

  test('worker arms its abort timer from timeout_at when present (one absolute deadline)', () => {
    expect(workerSrc).toContain('job.timeout_at.getTime() - Date.now()');
  });

  test('autopilot-cycle, global-maintenance AND phase-wrapper handlers thread deadlineAtMs into runCycle', () => {
    const matches = jobsSrc.match(/deadlineAtMs: job\.deadlineAtMs/g) ?? [];
    expect(matches.length).toBe(3);
  });

  test('runCycle forwards deadlineAtMs to the patterns phase', () => {
    expect(cycleSrc).toContain('deadlineAtMs: opts.deadlineAtMs ?? null');
  });

  test('patterns submits + waits with the CLAMPED budgets, not raw config', () => {
    expect(patternsSrc).toContain('timeout_ms: budgets.timeoutMs');
    expect(patternsSrc).toContain('timeoutMs: budgets.waitTimeoutMs');
    expect(patternsSrc).not.toContain('timeout_ms: config.subagentTimeoutMs');
    expect(patternsSrc).not.toContain('timeoutMs: config.subagentWaitTimeoutMs');
  });

  test('patterns cancels the child on wait timeout (child clock starts at ITS claim)', () => {
    // A child that sat queued can outlive the parent deadline the wait was
    // clamped to; the timeout path must strip it so it can't keep spending.
    expect(patternsSrc).toContain('queue.cancelJob(job.id)');
  });

  test('patterns skips honestly when the remaining budget is too small', () => {
    expect(patternsSrc).toContain('insufficient_cycle_budget');
    // Budget gate sits AFTER the provider probe so a no-provider brain
    // still reports no_provider (cheaper, more actionable reason).
    const probeIdx = patternsSrc.indexOf("skipped('no_provider'");
    // lastIndexOf: the doc comment on MIN_PATTERNS_SUBAGENT_BUDGET_MS
    // mentions the reason string too; the CALL SITE is the later hit.
    const budgetIdx = patternsSrc.lastIndexOf('insufficient_cycle_budget');
    expect(probeIdx).toBeGreaterThan(0);
    expect(budgetIdx).toBeGreaterThan(probeIdx);
  });
});
