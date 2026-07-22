/**
 * v0.38 — static-shape regression for autopilot.ts ↔ dispatchPerSource wiring.
 *
 * autopilot.ts's `shouldFullCycle` branch was rewired in this wave to
 * call `dispatchPerSource` from autopilot-fanout.ts instead of
 * submitting one `autopilot-cycle` job per tick. Because the autopilot
 * loop is deep inside `runAutopilot()` and gated by a connected engine,
 * a full integration test would require a Postgres fixture. The fan-out
 * helper itself has 27 unit tests + 6 PGLite/Postgres parity tests; this
 * file pins the WIRING in autopilot.ts so a future refactor that
 * accidentally reverts to single-job dispatch fails this guard first.
 *
 * Same pattern as test/autopilot-supervisor-wiring.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const AUTOPILOT_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'),
  'utf8',
);

describe('autopilot.ts ↔ dispatchPerSource wiring', () => {
  test('imports dispatchPerSource from the fan-out helper', () => {
    expect(AUTOPILOT_SRC).toMatch(
      /(import\s+.*dispatchPerSource.*from\s+['"]\.\/autopilot-fanout\.ts['"]|await import\(['"]\.\/autopilot-fanout\.ts['"]\))/,
    );
  });

  test('imports resolveEffectiveFanoutMax (clamps to worker concurrency; PGLite base still 1)', () => {
    // #2194 fix #1: autopilot now resolves the CLAMPED fan-out (gated on a live
    // supervisor) instead of the raw resolveFanoutMax. The clamp wraps
    // resolveFanoutMax, so PGLite's base-1 still holds (codex P1-3).
    expect(AUTOPILOT_SRC).toMatch(/resolveEffectiveFanoutMax/);
  });

  test('calls dispatchPerSource within the shouldFullCycle branch', () => {
    // dispatchPerSource must appear in the same hot path as the
    // pre-fix `queue.add('autopilot-cycle', ...)` did — i.e. when
    // shouldFullCycle is true, not in the targeted-plan path.
    const dispatchIdx = AUTOPILOT_SRC.indexOf('dispatchPerSource(engine, queue');
    expect(dispatchIdx).toBeGreaterThan(-1);
    // Verify shouldFullCycle is structurally near the call (within
    // ~3000 chars of source, roughly the same if/else branch)
    const fullCycleIdx = AUTOPILOT_SRC.indexOf('shouldFullCycle');
    expect(fullCycleIdx).toBeGreaterThan(-1);
    expect(Math.abs(dispatchIdx - fullCycleIdx)).toBeLessThan(3000);
  });

  test('updates lastFullCycleAt on dispatch (so the 60-min floor is honored)', () => {
    // After the dispatchPerSource call, the lastFullCycleAt module var
    // must update so the next tick doesn't immediately re-fan-out.
    expect(AUTOPILOT_SRC).toMatch(/lastFullCycleAt\s*=\s*Date\.now\(\)/);
  });

  test('does NOT regress to the single-job dispatch on the full-cycle path', () => {
    // Pre-PR: the shouldFullCycle branch did:
    //   const job = await queue.add('autopilot-cycle', { repoPath }, {
    //     idempotency_key: `autopilot-cycle:${slot}`, ...
    //   });
    // If a future refactor reintroduces this exact pattern in autopilot.ts,
    // the per-source fan-out has been silently reverted.
    //
    // Allow the legacy idempotency key shape ONLY inside dispatchPerSource's
    // fallback path (which is in autopilot-fanout.ts, not autopilot.ts).
    expect(AUTOPILOT_SRC).not.toMatch(/queue\.add\(['"]autopilot-cycle['"][\s\S]{0,400}idempotency_key:\s*`autopilot-cycle:\$\{slot\}`/);
  });
});
