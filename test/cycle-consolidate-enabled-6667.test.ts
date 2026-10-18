/**
 * #6667: `cycle.consolidate.enabled=false` is the off switch for the cycle's
 * consolidate phase (facts promoted into takes without review). The phase reads
 * it itself and returns `skipped`; `gbrain dream --phase consolidate --once`
 * (onceForPhase) bypasses it for one run. Unset or truthy keeps it on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';

let engine: PGLiteEngine;
const KEY = 'cycle.consolidate.enabled';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw('DELETE FROM config WHERE key = $1', [KEY]); });

const consolidateOf = async (opts: Record<string, unknown> = {}) => {
  const report = await runCycle(engine, { brainDir: null, phases: ['consolidate'], ...opts } as never);
  return report.phases.find(p => p.phase === 'consolidate')!;
};

describe('cycle.consolidate.enabled (#6667)', () => {
  test.each(['false', '0', 'off', 'no', ' FALSE '])('%p skips the phase in runCycle', async (value) => {
    await engine.setConfig(KEY, value);
    const phase = await consolidateOf();
    expect(phase.status).toBe('skipped');
    expect(phase.details).toMatchObject({ reason: 'disabled', enable_hint: `gbrain config set ${KEY} true` });
  });

  test.each([null, 'true', '1', 'on'])('%p keeps the phase on', async (value) => {
    if (value !== null) await engine.setConfig(KEY, value);
    const phase = await consolidateOf();
    expect(phase.status).not.toBe('skipped');
  });

  test('--once (onceForPhase consolidate) bypasses the switch for one run', async () => {
    await engine.setConfig(KEY, 'false');
    expect((await consolidateOf({ onceForPhase: 'consolidate' })).status).not.toBe('skipped');
    expect((await consolidateOf({ onceForPhase: 'patterns' })).status).toBe('skipped');
  });

  test('the phase entry point honors the switch directly', async () => {
    await engine.setConfig(KEY, 'false');
    expect((await runPhaseConsolidate(engine)).status).toBe('skipped');
    expect((await runPhaseConsolidate(engine, { once: true } as never)).status).not.toBe('skipped');
  });
});
