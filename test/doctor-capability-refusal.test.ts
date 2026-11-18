/**
 * Doctor on an engine that refuses a capability (the Rust engine's typed `engine_capability_missing`).
 *
 * - A check that reaches a refused capability reports each check it emits as a warning with unknown health, the
 *   capability named in details, and the run goes on to the next check; doctor does not stop on it.
 * - Any other error a check throws still propagates, as before.
 */
import { describe, expect, test } from 'bun:test';
import type { Check } from '../src/commands/doctor.ts';
import { runDoctorRegistry } from '../src/commands/doctor/registry.ts';
import { startDoctorDeadline } from '../src/commands/doctor/budget.ts';
import type { DoctorContext, DoctorEntry } from '../src/commands/doctor/context.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';

const noProgress = new Proxy({}, { get: () => () => undefined }) as DoctorContext['progress'];

function ctxFor(args: string[] = ['--json']): DoctorContext {
  return {
    engine: null, args, jsonOutput: true, fastMode: false, doFix: false, dryRun: false, scope: 'brain', orphanRatioSourceId: undefined,
    progress: noProgress, skillsDirResolution: { dir: null, source: 'none' }, skillsDir: null, autoFixReport: null, schemaVersion: 0,
    connectionFailed: false, only: null, tier: 'standard', deadline: startDoctorDeadline(args),
  };
}

const refusing: DoctorEntry = {
  name: 'refusing_probe', emits: ['refusing_a', 'refusing_b'],
  run: async () => { throw capabilityMissing('raw_sql', 'executeRaw'); },
};
const after: DoctorEntry = { name: 'after_probe', emits: ['after'], run: async () => [{ name: 'after', status: 'ok', message: 'ran' }] };

describe('doctor: a capability refusal is unknown health, not a stopped run', () => {
  test('each emitted check warns with the capability, and the next check runs', async () => {
    const checks = (await runDoctorRegistry(ctxFor(), [refusing, after])) as Check[];
    const view = checks.map((c) => ({ name: c.name, status: c.status, details: c.details }));
    expect(view).toEqual([
      { name: 'refusing_a', status: 'warn', details: { health: 'unknown', reason: 'engine_capability_missing', capability: 'raw_sql' } },
      { name: 'refusing_b', status: 'warn', details: { health: 'unknown', reason: 'engine_capability_missing', capability: 'raw_sql' } },
      { name: 'after', status: 'ok', details: undefined },
    ]);
    expect(checks[0]!.message).toStartWith('Health unknown: This brain\'s engine does not support executeRaw yet');
  });

  test('any other error still propagates', async () => {
    const broken: DoctorEntry = { name: 'broken', emits: ['broken'], run: async () => { throw new Error('boom'); } };
    await expect(runDoctorRegistry(ctxFor(), [broken, after])).rejects.toThrow('boom');
  });
});
