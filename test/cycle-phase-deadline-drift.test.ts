/**
 * #4168 drift guard — the phase deadline must stay STRICTLY under every
 * achievable autopilot-cycle job timeout, or the clean-exit path
 * (deadline_hit → partial result → cycle completes → cycle_freshness
 * advances) becomes structurally unreachable again.
 *
 * History that makes this guard load-bearing:
 *   - the old PHASE_DEADLINE_MS literal (30min) was bit-identical to the
 *     handler anchor the job floor derives from — dead code in production
 *     because the job clock starts at claim and the phase runs LATE.
 *   - the 30-minute floor itself has an add → revert → re-add history
 *     (#2852), so a future edit shifting either side is a live risk.
 *   - same class as #2781's duplicated timeout literal; the derived-view
 *     guard style follows test/model-pricing.test.ts and the derived-floor
 *     assertions in test/autopilot-fanout-wiring.test.ts.
 *
 * Source-shape assertions keep the literal from creeping back while the
 * derived constant survives as dead code.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  PROPOSE_TAKES_FALLBACK_DEADLINE_MS,
  PHASE_DEADLINE_FRACTION_OF_JOB,
  MIN_PROPOSE_TAKES_BUDGET_MS,
} from '../src/core/cycle/propose-takes.ts';
import { CYCLE_DEADLINE_RESERVE_MS } from '../src/core/cycle/base-phase.ts';
import { defaultTimeoutMsFor } from '../src/core/minions/handler-timeouts.ts';
import { resolveAutopilotDispatchTimeoutMs } from '../src/commands/autopilot-timeout.ts';

const proposeTakesSrc = readFileSync(
  new URL('../src/core/cycle/propose-takes.ts', import.meta.url).pathname, 'utf-8');
const cycleSrc = readFileSync(
  new URL('../src/core/cycle.ts', import.meta.url).pathname, 'utf-8');

describe('propose_takes deadline < job timeout (#4168)', () => {
  test('fallback deadline is strictly under the MINIMUM achievable full-cycle job timeout across plausible intervals', () => {
    const minAchievable = Math.min(
      ...[1, 60, 300, 900, 3600].map((i) => resolveAutopilotDispatchTimeoutMs(i, true)),
    );
    expect(PROPOSE_TAKES_FALLBACK_DEADLINE_MS).toBeLessThan(minAchievable);
    // The gap must absorb at least the cycle reserve — a 1ms win is a loss
    // once the clocks' different start points are accounted for.
    expect(minAchievable - PROPOSE_TAKES_FALLBACK_DEADLINE_MS)
      .toBeGreaterThanOrEqual(CYCLE_DEADLINE_RESERVE_MS);
  });

  test('fallback deadline is strictly under the handler anchor it derives from', () => {
    const anchor = defaultTimeoutMsFor('autopilot-cycle');
    expect(anchor).not.toBeNull();
    expect(PROPOSE_TAKES_FALLBACK_DEADLINE_MS).toBeLessThan(anchor!);
    expect(PROPOSE_TAKES_FALLBACK_DEADLINE_MS)
      .toBe(Math.floor(anchor! * PHASE_DEADLINE_FRACTION_OF_JOB));
    expect(PHASE_DEADLINE_FRACTION_OF_JOB).toBeLessThan(1);
    expect(MIN_PROPOSE_TAKES_BUDGET_MS).toBeLessThan(PROPOSE_TAKES_FALLBACK_DEADLINE_MS);
  });

  test('SOURCE SHAPE: no re-hardcoded 30-minute literal; the derivation stays referenced', () => {
    // The exact drift this issue is about: someone replaces the derived
    // constant with a literal that happens to equal the anchor again.
    expect(proposeTakesSrc).not.toMatch(/30\s*\*\s*60\s*\*\s*1000/);
    expect(proposeTakesSrc).not.toMatch(/1_?800_?000/);
    expect(proposeTakesSrc).toContain("defaultTimeoutMsFor('autopilot-cycle')");
    expect(proposeTakesSrc).toContain('resolveProposeTakesDeadlineMs');
  });

  test('SOURCE SHAPE: cycle.ts forwards deadlineAtMs to all THREE budgeted phases (patterns, propose_takes, synthesize)', () => {
    // eng F12: "two or more" would pass with the synthesize forward
    // forgotten. Count the exact literal shape used at every site.
    const forwards = cycleSrc.match(/deadlineAtMs: opts\.deadlineAtMs \?\? null/g) ?? [];
    expect(forwards.length).toBeGreaterThanOrEqual(3);
  });
});
