import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runEvalNightlyQuality } from '../src/commands/eval-nightly-quality.ts';
import { runNightlyQualityProbeStep } from '../src/commands/autopilot-probes.ts';
import { withEnv } from './helpers/with-env.ts';

test('scheduled probe stays disabled without the opt-in and writes nothing', async () => {
  const engine = {
    getConfig: async () => null,
    setConfig: async () => { throw new Error('unexpected write'); },
  } as unknown as BrainEngine;
  expect(await runNightlyQualityProbeStep(engine, null)).toEqual({ outcome: 'disabled', exit_code: 0 });
});

test('help does not read a brain or start the probe', async () => {
  const engine = new Proxy({}, { get: () => { throw new Error('help opened a brain'); } }) as BrainEngine;
  await withEnv({}, () => runEvalNightlyQuality(engine, ['--help']));
});
