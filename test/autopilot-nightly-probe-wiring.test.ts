/**
 * Source-shape regression tests for the v0.41 autopilot wiring of
 * `runNightlyQualityProbe`.
 *
 * The autopilot loop is hard to drive end-to-end without spinning a real
 * daemon (database, queue, gateway, etc). These tests pin the structural
 * shape of the wiring — the feature flag check, the try/catch, the DI
 * shape passed to runNightlyQualityProbe — so future refactors can't
 * silently strip the protections without a CI signal.
 *
 * The pure decision logic lives in shouldRunNightly (already pinned by
 * tests in nightly-quality-probe.test.ts).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AUTOPILOT_SRC = resolve('src/commands/autopilot.ts');
const SOURCE = readFileSync(AUTOPILOT_SRC, 'utf-8');

describe('autopilot wiring: nightly quality probe', () => {
  test('imports runNightlyQualityProbe from the phase module', () => {
    expect(SOURCE).toContain(`runNightlyQualityProbe`);
    expect(SOURCE).toContain(`nightly-quality-probe`);
  });

  test('uses the eng-D2 adapter module (not direct subprocess of eval-longmemeval/cross-modal)', () => {
    expect(SOURCE).toContain(`nightly-probe-adapters`);
    expect(SOURCE).toContain(`runLongMemEvalForProbe`);
    expect(SOURCE).toContain(`runCrossModalBatchForProbe`);
  });

  test('feature flag gate present: cfg.autopilot.nightly_quality_probe.enabled', () => {
    // Per D10: the scheduler ONLY checks the feature flag. The 24h rate-limit
    // lives inside runNightlyQualityProbe itself (no scheduler-side precheck).
    expect(SOURCE).toContain(`nightly_quality_probe?.enabled === true`);
  });

  test('NO scheduler-side rate-limit check (D10 simplification)', () => {
    // Codex round-1 #11 caught: scheduler-side rate-limit duplicates phase-internal logic.
    // The wiring code MUST NOT call shouldRunNightly directly OR read recent events
    // before invoking the phase.
    expect(SOURCE).not.toContain(`shouldRunNightly(`);
    expect(SOURCE).not.toContain(`readRecentQualityProbeEvents(`);
  });

  test('probe call wrapped in try/catch that does NOT bump consecutiveErrors', () => {
    // The try/catch around the probe must log the error but never crash the loop.
    // We verify the structural pattern: the probe call is inside a try block,
    // the catch block calls logError, and consecutiveErrors is not bumped inside the catch.
    expect(SOURCE).toMatch(/try\s*\{\s*[^}]*nightly_quality_probe/);
    expect(SOURCE).toMatch(/catch[\s\S]*?autopilot\.nightly_probe[\s\S]*?do NOT bump consecutiveErrors/);
  });

  test('DI shape: isEnabled / hasEmbeddingProvider / resolveMaxUsd / resolveRepoRoot / runLongMemEval / runCrossModalBatch / now', () => {
    // The exact 7 fields of NightlyProbeDeps.
    expect(SOURCE).toContain(`isEnabled:`);
    expect(SOURCE).toContain(`hasEmbeddingProvider:`);
    expect(SOURCE).toContain(`resolveMaxUsd:`);
    expect(SOURCE).toContain(`resolveRepoRoot:`);
    expect(SOURCE).toContain(`runLongMemEval:`);
    expect(SOURCE).toContain(`runCrossModalBatch:`);
    expect(SOURCE).toContain(`now:`);
  });

  test('hasEmbeddingProvider reads from gateway.isAvailable("embedding") (codex round-2 #12 — in-process, not subprocess)', () => {
    expect(SOURCE).toContain(`isAvailable('embedding')`);
    expect(SOURCE).toContain(`gateway`);
  });

  test('max_usd default = 5 when config unset (matches plan default per D10)', () => {
    expect(SOURCE).toMatch(/max_usd\s*\?\?\s*5/);
  });
});
