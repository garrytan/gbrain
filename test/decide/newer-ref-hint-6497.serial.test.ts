/**
 * #6497 `gbrain decide status`: the "newer reference available" hint only
 * names a shipped reference for the same slot, call site, provider and model
 * as the calibration in use, and the command it prints
 * (`gbrain decide calibrations adopt ref:<id>`) runs: `adopt` accepts a
 * `ref:` id for a reference whose slot matches and stores it verbatim in
 * `decide.slots.<slot>.calibration`.
 *
 * Before: the hint for `conflict` pointed at the last table row of the slot
 * (`review_withdraw`) while the status line reported the `sweep` calibration,
 * and `adopt ref:…` printed the usage line and exited 1.
 * Serial: captures console.log / console.error.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runDecideCommand } from '../../src/commands/decide.ts';
import * as references from '../../src/core/ai/decide/reference-calibrations.ts';
import type { ReferenceCalibration } from '../../src/core/ai/decide/reference-calibrations.ts';

const { REFERENCE_CALIBRATIONS } = references;
const newerReference: typeof references.newerReference = (...a) => references.newerReference(...a);

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('decide.provider', 'typesafe:jev-1.13.0');
  await engine.setConfig('decide.slots.conflict.mode', 'on');
});

async function decide(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  try {
    const code = await runDecideCommand(engine, args);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const SWEEP = REFERENCE_CALIBRATIONS.find((r) => r.slot === 'conflict' && r.call_site === 'sweep')!;
const WITHDRAW = REFERENCE_CALIBRATIONS.find((r) => r.slot === 'conflict' && r.call_site === 'review_withdraw')!;

describe('#6497 decide status newer-reference hint', () => {
  test('the conflict slot on the sweep reference gets no hint for the review_withdraw row', async () => {
    const { code, out } = await decide(['status', '--json']);
    expect(code).toBe(0);
    const conflict = JSON.parse(out).slots.find((s: { slot: string }) => s.slot === 'conflict');
    expect(conflict.calibration).toBe(`ref:${SWEEP.id}`);
    expect(conflict.newer_reference).toBeNull();
    const human = await decide(['status']);
    expect(human.out).not.toContain('newer reference available');
  });

  test('newerReference matches slot, call site, provider and model and ignores other call sites', () => {
    const policy = { slot: 'conflict' as const, callSite: 'sweep', provider: 'typesafe:jev-1.13.0', model: 'jev-1.13.0', calibration: { ref: `ref:${SWEEP.id}` } };
    expect(newerReference(policy)).toBeNull();
    const newer: ReferenceCalibration = { ...SWEEP, id: 'conflict-jev-1.13.0-2099-01-01', shipped_in: '9.9.9.9' };
    expect(newerReference(policy, [...REFERENCE_CALIBRATIONS, newer])).toBe(`ref:${newer.id}`);
    expect(newerReference(policy, [...REFERENCE_CALIBRATIONS, { ...newer, call_site: 'review_withdraw' }])).toBeNull();
    expect(newerReference(policy, [...REFERENCE_CALIBRATIONS, { ...newer, model_resolved: 'jev-2.0.0' }])).toBeNull();
    expect(newerReference(policy, [...REFERENCE_CALIBRATIONS, { ...newer, provider: 'typesafe:jev-2.0.0' }])).toBeNull();
    expect(newerReference({ ...policy, calibration: undefined }, [...REFERENCE_CALIBRATIONS, newer])).toBeNull();
    expect(newerReference({ ...policy, calibration: { ref: `ref:${newer.id}` } }, [...REFERENCE_CALIBRATIONS, newer])).toBeNull();
  });
});

describe('#6497 decide calibrations adopt ref:<id>', () => {
  test('adopts a shipped reference verbatim and status reports it', async () => {
    const adopt = await decide(['calibrations', 'adopt', `ref:${SWEEP.id}`]);
    expect(adopt.code).toBe(0);
    expect(adopt.err).toBe('');
    expect(adopt.out).toContain(`ref:${SWEEP.id}`);
    expect(await engine.getConfig('decide.slots.conflict.calibration')).toBe(`ref:${SWEEP.id}`);
    const { out } = await decide(['status', '--json']);
    const conflict = JSON.parse(out).slots.find((s: { slot: string }) => s.slot === 'conflict');
    expect(conflict.calibration).toBe(`ref:${SWEEP.id}`);
    expect(conflict.threshold_source).toBe('reference');
    expect(conflict.newer_reference).toBeNull();
    const other = await decide(['calibrations', 'adopt', `ref:${WITHDRAW.id}`]);
    expect(other.code).toBe(0);
    expect(await engine.getConfig('decide.slots.conflict.calibration')).toBe(`ref:${WITHDRAW.id}`);
  });

  test('an unknown ref id is refused without writing config', async () => {
    const adopt = await decide(['calibrations', 'adopt', 'ref:conflict-nope-2099-01-01']);
    expect(adopt.code).toBe(1);
    expect(adopt.err).toContain('ref:conflict-nope-2099-01-01');
    expect(adopt.err).toContain('not found');
    expect(await engine.getConfig('decide.slots.conflict.calibration')).toBeNull();
  });
});
