/**
 * Refactor wave 1 (W4 jobs, A15): built-in Minion handler registry golden.
 *
 * `registerBuiltinHandlers` (exported from src/commands/jobs.ts) is the one
 * place a `gbrain jobs work` worker learns which job names it can claim, and
 * the supervisor derives its wedge-watchdog name scope from the same call
 * (supervisor.ts deriveHandlerNames, issue #1801). Moving the handler bodies
 * into src/core/minions/handlers/ must keep the registered names AND their
 * order identical: a dropped name fails every job of that type with "no
 * handler", and the order is what the supervisor probe and `registeredNames`
 * report.
 *
 * Captured on the pre-move code. Normalizer `jobs-handler-registry-v1`:
 * identity (names are static strings; the list keeps registration order).
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { MinionSupervisor } from '../src/core/minions/supervisor.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { defineNormalizer, expectGolden, expectNormalizerStable } from './helpers/golden.ts';

const REGISTRY_NORMALIZER = defineNormalizer<string[]>('jobs-handler-registry-v1', (names) => names);

/** Registration never touches the engine; factories only close over it. */
const stubEngine = { kind: 'postgres' } as unknown as BrainEngine;

async function captureRegisteredNames(): Promise<string[]> {
  const names: string[] = [];
  const recorder = {
    register(name: string, handler: unknown) {
      if (typeof handler !== 'function') throw new Error(`handler for ${name} is not a function`);
      names.push(name);
    },
  };
  await registerBuiltinHandlers(recorder as never, stubEngine, { quiet: true });
  return names;
}

describe('registerBuiltinHandlers registry (W4 jobs golden)', () => {
  test('registered job names and order equal the pre-move golden', async () => {
    const names = await expectNormalizerStable(captureRegisteredNames, REGISTRY_NORMALIZER);
    expect(new Set(names).size).toBe(names.length);
    expectGolden('jobs/handler-registry', names, REGISTRY_NORMALIZER);
  });

  test('a real MinionWorker reports the same names in the same order', async () => {
    const worker = new MinionWorker(stubEngine, { queue: 'default', healthCheckInterval: 0 });
    await registerBuiltinHandlers(worker, stubEngine, { quiet: true });
    expect([...worker.registeredNames]).toEqual(await captureRegisteredNames());
  });
});

describe('supervisor handler-name probe (issue #1801 path)', () => {
  test('deriveHandlerNames dynamically imports registerBuiltinHandlers from src/commands/jobs.ts and records every name', async () => {
    const events: Array<{ event: string }> = [];
    const sup = new MinionSupervisor(stubEngine, {
      cliPath: '/bin/true',
      maxRssMb: 0,
      healthInterval: 0,
      onEvent: (e) => events.push(e as { event: string }),
    });
    const probe = sup as unknown as { deriveHandlerNames(): Promise<void>; handlerNames: string[] };
    await probe.deriveHandlerNames();
    expect(events.filter((e) => e.event === 'health_warn')).toEqual([]);
    expect(probe.handlerNames).toEqual(await captureRegisteredNames());
    expect(probe.handlerNames.length).toBeGreaterThan(0);
  });
});
