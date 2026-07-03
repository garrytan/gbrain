/**
 * test/cycle-abort.test.ts — Verify runCycle respects AbortSignal.
 *
 * Regression test for the 2026-04-24 incident where 98 jobs piled up
 * because autopilot-cycle's handler didn't propagate AbortSignal to
 * runCycle, and runCycle had no signal-checking between phases.
 *
 * Tests the three-layer fix:
 *   1. CycleOpts.signal — runCycle checks signal between phases
 *   2. Handler wiring — autopilot-cycle passes job.signal
 *   3. Worker force-eviction — last resort if handler ignores abort
 *
 * Layer 3 is tested in minions.test.ts (worker-level). This file
 * covers layers 1 and 2 via the cycle interface.
 */

import { describe, test, expect } from 'bun:test';

// We can't easily import runCycle with a real engine for unit tests,
// but we CAN test the checkAborted pattern and CycleOpts contract.

describe('CycleOpts.signal contract (v0.20.5)', () => {
  test('signal field exists on CycleOpts interface', async () => {
    // Type-level test: importing the type should work
    const mod = await import('../src/core/cycle.ts');
    // runCycle exists and is callable
    expect(typeof mod.runCycle).toBe('function');
  });

  test('runCycle accepts signal in opts without error', async () => {
    // Verify runCycle doesn't crash when signal is passed but no engine
    const { runCycle } = await import('../src/core/cycle.ts');
    const abort = new AbortController();

    // Call with null engine + minimal opts — should return a report
    // (phases that need engine will be skipped)
    const report = await runCycle(null, {
      brainDir: '/nonexistent-for-test',
      phases: [], // empty phases = no work
      signal: abort.signal,
    });

    expect(report.schema_version).toBe('1');
    expect(report.status).toBeDefined();
  });

  test('runCycle bails on pre-aborted signal', async () => {
    const { runCycle } = await import('../src/core/cycle.ts');
    const abort = new AbortController();
    abort.abort(new Error('timeout'));

    // With a pre-aborted signal and phases that would run, it should
    // throw or return failed (depending on which phase catches it first)
    try {
      const report = await runCycle(null, {
        brainDir: '/nonexistent-for-test',
        phases: ['lint'], // lint doesn't need engine, would normally run
        signal: abort.signal,
      });
      // If it returns instead of throwing, status should reflect the abort
      expect(['failed', 'partial']).toContain(report.status);
    } catch (err) {
      // checkAborted threw — this is the expected behavior
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message).toContain('aborted');
    }
  });

  test('runCycle bails mid-flight when signal fires between phases', async () => {
    const { runCycle } = await import('../src/core/cycle.ts');
    const abort = new AbortController();

    // Abort after 50ms — should catch between phases
    setTimeout(() => abort.abort(new Error('timeout')), 50);

    try {
      const report = await runCycle(null, {
        brainDir: '/nonexistent-for-test',
        phases: ['lint', 'backlinks', 'orphans'],
        signal: abort.signal,
        yieldBetweenPhases: async () => {
          // Slow yield to give the abort time to fire
          await new Promise(r => setTimeout(r, 100));
        },
      });
      // If it returned cleanly, not all phases should have run
      // (abort should have prevented later phases)
      const completedPhases = report.phases.length;
      expect(completedPhases).toBeLessThan(3);
    } catch (err) {
      // checkAborted threw between phases — expected
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message).toContain('aborted');
    }
  });
});

describe('autopilot-cycle handler contract (v0.20.5)', () => {
  test('handler registration passes signal to runCycle', async () => {
    // Verify the handler code in jobs.ts includes job.signal
    const fs = await import('fs');
    const jobsSource = fs.readFileSync(
      new URL('../src/commands/jobs.ts', import.meta.url),
      'utf8',
    );

    // The autopilot-cycle handler MUST pass signal to runCycle.
    // Source-level regression guard.
    //
    // The slice window was bumped to 6000 in v0.39 — the v0.38 wave added
    // source_id validation + archive recheck + pull-flag threading at the
    // top of the handler, which pushed the runCycle({signal:...}) call past
    // the original 2000-char ceiling. The intent of the guard is unchanged:
    // "the autopilot-cycle handler passes job.signal to runCycle." The
    // window just needs to be wide enough to span any reasonable handler.
    const handlerStart = jobsSource.indexOf("worker.register('autopilot-cycle'");
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerBlock = jobsSource.slice(handlerStart, handlerStart + 6000);

    expect(handlerBlock).toContain('signal: job.signal');
  });

  test('worker.ts has force-eviction safety net after timeout', async () => {
    // Verify the worker code includes the grace timer
    const fs = await import('fs');
    const workerSource = fs.readFileSync(
      new URL('../src/core/minions/worker.ts', import.meta.url),
      'utf8',
    );

    // Must have the force-eviction pattern
    expect(workerSource).toContain('Force-evicting from inFlight');
    expect(workerSource).toContain('graceTimer');
    expect(workerSource).toContain('handler ignored abort signal');
  });

  test('cycle.ts has checkAborted calls between phases', async () => {
    // Verify the cycle code checks abort between every phase
    const fs = await import('fs');
    const cycleSource = fs.readFileSync(
      new URL('../src/core/cycle.ts', import.meta.url),
      'utf8',
    );

    // Count checkAborted calls in the runCycle function body
    const runCycleBody = cycleSource.slice(
      cycleSource.indexOf('export async function runCycle'),
    );
    const checkCalls = (runCycleBody.match(/checkAborted\(opts\.signal\)/g) || []).length;

    // Should have at least 6 (one per phase)
    expect(checkCalls).toBeGreaterThanOrEqual(6);
  });
});

describe('#1972 — complete cooperative-abort coverage', () => {
  test('aborted signal makes runCycle report partial + reason "aborted" (terminal guard)', async () => {
    // phases:[] means no between-phase checkAborted fires, so execution reaches
    // the TERMINAL guard (Codex #9). With a pre-aborted signal it must NOT
    // report success — status 'partial', reason 'aborted'.
    const { runCycle } = await import('../src/core/cycle.ts');
    const abort = new AbortController();
    abort.abort(new Error('timeout'));
    const report = await runCycle(null, {
      brainDir: '/nonexistent-for-test',
      phases: [],
      signal: abort.signal,
    });
    expect(report.status).toBe('partial');
    expect(report.reason).toBe('aborted');
  });

  test('cycle.ts threads opts.signal into every long phase + guards the success stamp', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('../src/core/cycle.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function runCycle'));
    // Each long phase receives the signal.
    expect(body).toContain('runPhaseExtract(engine, brainDir, dryRun, syncPagesAffected, opts.signal)');
    expect(body).toMatch(/runPhaseExtractFacts\([^)]*opts\.signal\)/);
    expect(body).toContain('signal: opts.signal'); // consolidate opts
    expect(body).toContain('runPhaseLint(brainDir, dryRun, engine, opts.signal)');
    // Reaper runs at cycle start.
    expect(body).toContain('reapDeadHolderLocks(engine)');
    // Terminal guard: the success stamp is gated on !aborted, and the report
    // carries reason 'aborted'.
    expect(body).toContain('!aborted');
    expect(body).toContain("reason: 'aborted'");
    // Phase-duration force-evict attribution log (T11).
    expect(body).toContain('FORCE_EVICT_DEADLINE_MS');
  });

  test('every long phase core checks isAborted in its batch loop', async () => {
    const fs = await import('fs');
    const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
    expect(read('../src/commands/extract.ts')).toContain('if (isAborted(signal)) return;');
    expect(read('../src/core/cycle/extract-facts.ts')).toContain('if (isAborted(opts.signal)) break;');
    expect(read('../src/core/cycle/phases/consolidate.ts')).toContain('if (isAborted(opts.signal)) break;');
    expect(read('../src/core/cycle/phantom-redirect.ts')).toContain('if (isAborted(signal)) break;');
    expect(read('../src/commands/lint.ts')).toContain('if (isAborted(opts.signal)) break;');
  });
});
