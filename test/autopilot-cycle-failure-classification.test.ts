/**
 * test/autopilot-cycle-failure-classification.test.ts
 *
 * Regression guards for two design-bugs that interact under
 * `KeepAlive=true` autopilot to produce a respawn storm:
 *
 *   1. autopilot.ts inline-cycle path treated `report.status === 'partial'`
 *      as a circuit-breaker trip. `partial` is documented in CycleReport
 *      as "at least one phase warned or failed, others ran" — a soft
 *      signal, not a fatal condition. 5 consecutive 'partial' cycles
 *      killed the autopilot.
 *
 *   2. runPhaseOrphans used a fixed absolute threshold `count > 20` to
 *      emit `status: 'warn'`. For any non-trivial brain (~hundreds of
 *      pages) that fires every cycle in steady state, which —
 *      combined with bug #1 — caused the autopilot to give up after
 *      5 normal cycles. Threshold is now ratio-based: warn only if more
 *      than half the corpus is orphaned.
 *
 * Both fixes are tiny but the production blast-radius is large
 * (LaunchAgent respawn loop, 9 MB error log in 2h), so they get
 * explicit guards.
 *
 * Source-level guards follow the established pattern from
 * `cycle-abort.test.ts` (autopilot loop is hard to unit-test without
 * a full engine, so we assert on source text).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

const autopilotSource = readFileSync(
  new URL('../src/commands/autopilot.ts', import.meta.url),
  'utf8',
);
const cycleSource = readFileSync(
  new URL('../src/core/cycle.ts', import.meta.url),
  'utf8',
);

describe("autopilot cycle-failure classification — only 'failed' trips the circuit breaker", () => {
  test("the inline-cycle path does NOT treat 'partial' as cycleOk=false", () => {
    // Find the inline-cycle block (the catch-and-inspect on `report`)
    const inlineBlockStart = autopilotSource.indexOf("event: 'cycle-inline'");
    expect(inlineBlockStart).toBeGreaterThan(0);

    // Look at the 800 chars before the JSON event line — that's where the
    // cycleOk classification happens.
    const inlineContext = autopilotSource.slice(
      Math.max(0, inlineBlockStart - 800),
      inlineBlockStart,
    );

    // Regression guard #1: the OR-with-'partial' branch must be gone.
    expect(inlineContext).not.toMatch(/report\.status\s*===\s*['"]partial['"]/);

    // Positive guard: the breaker still trips on 'failed'.
    expect(inlineContext).toMatch(/report\.status\s*===\s*['"]failed['"]/);
  });

  test("the 5-consecutive-error give-up is still wired (regression-safety)", () => {
    // The fix narrows the trigger; it doesn't remove the breaker.
    // If someone later wholesale deletes the give-up branch we want to
    // notice — autopilot still needs a way to stop after sustained
    // real failures (e.g., DB unreachable for 5 cycles).
    expect(autopilotSource).toMatch(/consecutiveErrors\s*\+\+/);
    expect(autopilotSource).toMatch(/consecutiveErrors\s*>=\s*5/);
  });
});

describe('runPhaseOrphans ratio threshold — no more absolute count > 20', () => {
  test('the legacy `count > 20 ? "warn" : "ok"` ternary is gone', () => {
    // The literal that produced the steady-state warn-storm on any
    // brain past a few hundred pages.
    expect(cycleSource).not.toMatch(/count\s*>\s*20\s*\?\s*['"]warn['"]/);
  });

  test('the new threshold is ratio-based against total_pages', () => {
    // Must look at result.total_pages, not a magic absolute. The
    // exact comparator (0.5 today) can move, but the *kind* of
    // comparison must be a ratio so big brains don't always warn.
    // Slice the runPhaseOrphans function body.
    const fnIdx = cycleSource.indexOf('async function runPhaseOrphans');
    expect(fnIdx).toBeGreaterThan(0);
    const fnEnd = cycleSource.indexOf('\n}', fnIdx);
    const fnBody = cycleSource.slice(fnIdx, fnEnd);

    // Must reference total_pages in the threshold decision.
    expect(fnBody).toMatch(/total_pages/);
    // Must contain a division or multiplication against total_pages
    // (ratio comparison). Accept either `count / result.total_pages` or
    // `count > result.total_pages * X` framing.
    expect(fnBody).toMatch(
      /count\s*\/\s*result\.total_pages|result\.total_pages\s*\*/,
    );
  });

  test('the warn branch still exists (we narrowed, did not remove)', () => {
    // If the threshold is moved to "never warn", we want a deliberate
    // signal. Today the warn path is still there — orphans > 50% of
    // corpus is a real signal. This guard catches accidental removal.
    const fnIdx = cycleSource.indexOf('async function runPhaseOrphans');
    const fnEnd = cycleSource.indexOf('\n}', fnIdx);
    const fnBody = cycleSource.slice(fnIdx, fnEnd);
    expect(fnBody).toMatch(/['"]warn['"]/);
    expect(fnBody).toMatch(/['"]ok['"]/);
  });
});
