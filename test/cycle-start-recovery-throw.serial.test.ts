/**
 * Pins the catch arm of the cycle-start private-queue recovery lane
 * (src/core/cycle.ts ~:2054): recovery is best-effort and must NEVER block
 * the cycle — a throwing reconcileOrphanedPrivateQueues is swallowed with a
 * warning and runCycle still completes.
 *
 * Serial (*.serial.test.ts): uses mock.module, which leaks across files in a
 * shared shard process. The mock swaps MinionQueue for a subclass whose
 * reconcileOrphanedPrivateQueues throws while every other member stays real
 * (`const real = await import(...)` re-export pattern, same style as
 * test/cycle-patterns-completed-outcome.serial.test.ts).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

const real = await import('../src/core/minions/queue.ts');

let reconcileCalls = 0;

class ThrowingRecoveryQueue extends real.MinionQueue {
  override async reconcileOrphanedPrivateQueues(): Promise<never> {
    reconcileCalls++;
    throw new Error('injected reconcile failure (cycle-start-recovery-throw)');
  }
}

mock.module('../src/core/minions/queue.ts', () => ({
  ...real,
  MinionQueue: ThrowingRecoveryQueue,
}));

// Import AFTER the mock so cycle.ts's dynamic `import('./minions/queue.ts')`
// at the recovery site resolves to the throwing subclass.
const { runCycle } = await import('../src/core/cycle.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('cycle-start recovery failure is non-fatal (cycle.ts catch arm)', () => {
  test('runCycle completes even when reconcileOrphanedPrivateQueues throws', async () => {
    const report = await runCycle(engine, { brainDir: null, phases: [] });
    // The lane was actually reached (the mock threw) AND the cycle survived.
    expect(reconcileCalls).toBe(1);
    expect(report.phases).toEqual([]);
    expect(typeof report.status).toBe('string');
  }, 60_000);
});
