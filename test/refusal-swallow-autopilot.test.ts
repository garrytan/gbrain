/**
 * Refusal-swallow sites in the autopilot daemon, dispatch and fan-out (triage rows 1-5): a catch around a raw-SQL read
 * must not turn the Rust engine's `engine_capability_missing` refusal into a quiet default.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: when the engine refuses the read with the real capability refusal (`capabilityMissing`), the site
 *    surfaces it; every other error still takes the path's old fallback (a SQL engine's blip is not a refusal).
 *  - Regression: the refusal was logged or dropped and the loop carried on (no-worker warning never fires, auto-drain not
 *    submitted, no cooldown data, idle answered false), so a Rust brain looked healthy while a stage was missing.
 *  - Why existing coverage misses it: the autopilot tests script `executeRaw` with generic errors only.
 *  - Seam: an engine stub whose `executeRaw` throws the real refusal object; the Rust engine itself is not driven here
 *    because the daemon never dispatches through the queue on a Rust brain (the gate test below proves it).
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { autopilotUsesMinionsDispatch, probeNoWorkerPeer, type AutopilotDaemonState } from '../src/commands/autopilot-daemon.ts';

const REFUSAL = () => capabilityMissing('raw_sql', 'executeRaw');

function stubEngine(executeRaw: () => Promise<unknown>, extra: Record<string, unknown> = {}): BrainEngine {
  return { kind: 'rust', executeRaw, ...extra } as unknown as BrainEngine;
}

function daemonState(): AutopilotDaemonState {
  return { noWorkerConsecutiveIdle: 0 } as AutopilotDaemonState;
}

describe('autopilot refusal-swallow sites', () => {
  test('S1 probeNoWorkerPeer: a capability refusal surfaces; a transient error is logged and the loop carries on', async () => {
    const state = daemonState();
    await expect(probeNoWorkerPeer(stubEngine(async () => { throw REFUSAL(); }), state, 60))
      .rejects.toMatchObject({ code: 'engine_capability_missing' });
    expect(state.noWorkerConsecutiveIdle).toBe(0);
    await probeNoWorkerPeer(stubEngine(async () => { throw new Error('connection reset'); }), state, 60);
    expect(state.noWorkerConsecutiveIdle).toBe(0);
  });

  test('S1 gate: a Rust brain never reaches the no-worker probe, the fan-out cooldown read or the auto-drain submit', () => {
    expect(autopilotUsesMinionsDispatch('pain_triggered', 'rust', false)).toBe(false);
    expect(autopilotUsesMinionsDispatch('always', 'rust', false)).toBe(false);
    expect(autopilotUsesMinionsDispatch('pain_triggered', 'pglite', false)).toBe(false);
    expect(autopilotUsesMinionsDispatch('pain_triggered', 'postgres', false)).toBe(true);
    expect(autopilotUsesMinionsDispatch('off', 'postgres', false)).toBe(false);
    expect(autopilotUsesMinionsDispatch('pain_triggered', 'postgres', true)).toBe(false);
  });
});
