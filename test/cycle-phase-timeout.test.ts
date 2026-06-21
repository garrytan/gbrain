/**
 * test/cycle-phase-timeout.test.ts
 *
 * Unit tests for resolvePhaseTimeoutMs and runPhaseWithTimeout from
 * src/core/cycle.ts.  Zero DB, zero filesystem, zero network.
 */

import { describe, test, expect } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import {
  resolvePhaseTimeoutMs,
  runPhaseWithTimeout,
} from '../src/core/cycle.ts';
import type { PhaseResult } from '../src/core/cycle.ts';

// ─── resolvePhaseTimeoutMs ─────────────────────────────────────────────────

describe('resolvePhaseTimeoutMs', () => {
  test('returns 0 when env is unset and no explicit arg', async () => {
    await withEnv({ GBRAIN_PHASE_TIMEOUT_SECONDS: undefined }, () => {
      expect(resolvePhaseTimeoutMs()).toBe(0);
    });
  });

  test('returns 0 when explicit arg is 0', async () => {
    await withEnv({ GBRAIN_PHASE_TIMEOUT_SECONDS: undefined }, () => {
      expect(resolvePhaseTimeoutMs(0)).toBe(0);
    });
  });

  test('converts explicit arg 600 → 600000 ms', async () => {
    await withEnv({ GBRAIN_PHASE_TIMEOUT_SECONDS: undefined }, () => {
      expect(resolvePhaseTimeoutMs(600)).toBe(600_000);
    });
  });

  test('reads GBRAIN_PHASE_TIMEOUT_SECONDS="600" → 600000 ms', async () => {
    await withEnv({ GBRAIN_PHASE_TIMEOUT_SECONDS: '600' }, () => {
      expect(resolvePhaseTimeoutMs()).toBe(600_000);
    });
  });

  test('explicit arg wins over env', async () => {
    await withEnv({ GBRAIN_PHASE_TIMEOUT_SECONDS: '300' }, () => {
      expect(resolvePhaseTimeoutMs(600)).toBe(600_000);
    });
  });

  test('invalid env "abc" → 0', async () => {
    await withEnv({ GBRAIN_PHASE_TIMEOUT_SECONDS: 'abc' }, () => {
      expect(resolvePhaseTimeoutMs()).toBe(0);
    });
  });

  test('invalid env "0" → 0 (not > 0)', async () => {
    await withEnv({ GBRAIN_PHASE_TIMEOUT_SECONDS: '0' }, () => {
      expect(resolvePhaseTimeoutMs()).toBe(0);
    });
  });

  test('invalid env "-5" → 0', async () => {
    await withEnv({ GBRAIN_PHASE_TIMEOUT_SECONDS: '-5' }, () => {
      expect(resolvePhaseTimeoutMs()).toBe(0);
    });
  });
});

// ─── runPhaseWithTimeout ────────────────────────────────────────────────────

/** Minimal PhaseResult factory for test stubs */
function okResult(phase = 'embed' as PhaseResult['phase']): PhaseResult {
  return { phase, status: 'ok', duration_ms: 0, summary: 'done', details: {} };
}

describe('runPhaseWithTimeout', () => {
  test('passthrough: phaseTimeoutMs<=0 calls run with parent signal, returns unchanged', async () => {
    const ac = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const run = async (sig: AbortSignal | undefined): Promise<PhaseResult> => {
      receivedSignal = sig;
      return okResult();
    };
    const result = await runPhaseWithTimeout('embed', ac.signal, 0, run);
    expect(result.status).toBe('ok');
    expect(receivedSignal).toBe(ac.signal);
  });

  test('deadline fires: returns skipped with phase_timeout reason', async () => {
    const phaseTimeoutMs = 30;
    // The run callback waits until its signal aborts, then resolves with ok.
    const run = async (sig: AbortSignal | undefined): Promise<PhaseResult> => {
      return new Promise((resolve) => {
        if (sig?.aborted) {
          resolve(okResult());
          return;
        }
        sig?.addEventListener('abort', () => resolve(okResult()), { once: true });
        // Also set a safety-valve timeout so the test doesn't hang if signal never fires.
        setTimeout(() => resolve(okResult()), 500);
      });
    };
    const result = await runPhaseWithTimeout('embed', undefined, phaseTimeoutMs, run);
    expect(result.status).toBe('skipped');
    expect(result.details.reason).toBe('phase_timeout');
    expect(result.details.timeout_ms).toBe(phaseTimeoutMs);
  });

  test('fast phase: phaseTimeoutMs=1000, run resolves immediately → returns ok', async () => {
    const run = async (_sig: AbortSignal | undefined): Promise<PhaseResult> => okResult();
    const result = await runPhaseWithTimeout('embed', undefined, 1000, run);
    expect(result.status).toBe('ok');
  });

  test('cycle abort (parent): parentSignal aborted → NOT relabeled as phase_timeout', async () => {
    const parent = new AbortController();
    parent.abort(new Error('cycle cancelled'));

    const run = async (sig: AbortSignal | undefined): Promise<PhaseResult> => {
      // Simulate the phase throwing when its signal is aborted (parent abort forwarded).
      if (sig?.aborted) throw sig.reason ?? new Error('aborted');
      return okResult();
    };

    // Should reject / throw, not return a phase_timeout skipped result.
    await expect(
      runPhaseWithTimeout('embed', parent.signal, 1000, run),
    ).rejects.toThrow();
  });

  test('no timer leak: fast phase completes without hanging the process', async () => {
    // If clearTimeout is not called, bun test would hang after a 1000ms timer fires.
    // The fact that this test returns promptly is the assertion.
    const run = async (_sig: AbortSignal | undefined): Promise<PhaseResult> => okResult();
    const before = Date.now();
    const result = await runPhaseWithTimeout('embed', undefined, 1000, run);
    const elapsed = Date.now() - before;
    expect(result.status).toBe('ok');
    // Should complete well within the 1000ms deadline.
    expect(elapsed).toBeLessThan(500);
  });

  // ── Adversarial tests for hardened runPhaseWithTimeout behaviour ─────────

  test('preserves partial counts on deadline truncation', async () => {
    // The phase resolves via the abort listener (simulating a batch-boundary
    // self-truncation that returns partial work). The partial details must be
    // merged into the phase_timeout skipped result.
    const phaseTimeoutMs = 30;
    const run = (sig: AbortSignal | undefined): Promise<PhaseResult> =>
      new Promise((resolve) => {
        const partial: PhaseResult = {
          phase: 'embed',
          status: 'ok',
          duration_ms: 0,
          summary: 'partial',
          details: { embedded: 5, foo: 'bar' },
        };
        if (sig?.aborted) { resolve(partial); return; }
        sig?.addEventListener('abort', () => resolve(partial), { once: true });
        // Safety valve so the test cannot hang if the signal never fires.
        setTimeout(() => resolve(partial), 500);
      });

    const result = await runPhaseWithTimeout('embed', undefined, phaseTimeoutMs, run);
    expect(result.status).toBe('skipped');
    expect(result.details.reason).toBe('phase_timeout');
    expect(result.details.timeout_ms).toBe(phaseTimeoutMs);
    // Partial counts from the phase's own result must survive the relabel.
    expect(result.details.embedded).toBe(5);
    expect(result.details.foo).toBe('bar');
  });

  test('does NOT mislabel a real error as phase_timeout', async () => {
    // The run callback ignores the signal and throws a genuine application
    // error after the deadline. runPhaseWithTimeout must NOT swallow it.
    const phaseTimeoutMs = 30;
    const run = async (_sig: AbortSignal | undefined): Promise<PhaseResult> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      throw new Error('db exploded');
    };

    await expect(
      runPhaseWithTimeout('embed', undefined, phaseTimeoutMs, run),
    ).rejects.toThrow('db exploded');
  });

  test('relabels a genuine abort throw as phase_timeout', async () => {
    // The run callback throws an AbortError when the deadline fires.
    // This is the canonical "phase throws on abort" pattern; it should be
    // relabeled phase_timeout rather than propagated.
    const phaseTimeoutMs = 30;
    const run = (sig: AbortSignal | undefined): Promise<PhaseResult> =>
      new Promise((_resolve, reject) => {
        if (sig?.aborted) {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e); return;
        }
        sig?.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        }, { once: true });
        // Safety valve — reject after a long wait so the test cannot hang.
        setTimeout(() => reject(new Error('safety-valve timeout')), 500);
      });

    const result = await runPhaseWithTimeout('embed', undefined, phaseTimeoutMs, run);
    expect(result.status).toBe('skipped');
    expect(result.details.reason).toBe('phase_timeout');
  });
});
