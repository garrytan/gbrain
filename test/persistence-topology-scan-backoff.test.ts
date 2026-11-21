/**
 * The owner's topology recovery scan in the persistence consumer (persistence/consumer.ts `scanTopologies`) and its
 * capability backoff.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on an engine with or without `raw_sql` (the Rust shape) the scan runs on every tick and reports nothing
 *    when no change is recovering, since topology recovery needs no raw SQL (topology-recovery.ts). A capability
 *    refusal from a step the scan reaches (the Rust engine resuming a refresh another engine recorded) is reported once
 *    and parks the scan for TOPOLOGY_STOP_BACKOFF_MS: the next tick neither scans nor reports again, and it does not
 *    throw. Any other scan error is reported and the next tick scans again.
 *  - Regression: the scan refused on every scanning tick of a Rust owner while a change was recovering; it now
 *    converges the change on every engine, and a refusal it still meets parks it instead of repeating every tick.
 *  - Why existing coverage misses it: the parity case (test/engine-parity/topology-recovery.test.ts) runs the scan
 *    function itself; the consumer's tick wiring and its backoff are only reachable through the consumer.
 *  - Seam: a proxy over a real PGLite engine; the Rust shape drops raw_sql from its capability set, and `scanError`
 *    makes listTopologyRecoveries throw (the capability refusal is the real capabilityMissing error).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PersistenceConsumer, TOPOLOGY_STOP_BACKOFF_MS } from '../src/core/persistence/consumer.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';

/** The real engine; `rustShape` drops raw_sql; `scanError` makes the list throw it. */
function shaped(engine: BrainEngine, opts: { rustShape: boolean; scanError?: Error }) {
  const scans: unknown[][] = [];
  const capabilities = new Set([...engine.capabilities].filter(c => !opts.rustShape || c !== 'raw_sql'));
  const proxy = new Proxy(engine, {
    get(target, key) {
      if (key === 'capabilities') return capabilities;
      if (key === 'listTopologyRecoveries') return async (...args: unknown[]) => {
        scans.push(args);
        if (opts.scanError) throw opts.scanError;
        return (target.listTopologyRecoveries as (...a: unknown[]) => unknown).apply(target, args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine: proxy as BrainEngine, scans };
}

/** A consumer over `engine` whose reports land in `errors`, and one tick's topology scan, awaited. */
function owner(engine: BrainEngine) {
  const errors: unknown[] = [];
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' } as GBrainConfig,
    async () => { throw new Error('the topology scan prepares nothing'); }, { hostId: randomUUID(), onError: error => { errors.push(error); } });
  const internals = consumer as unknown as { scanTopologies(): void; topologyWorker?: Promise<unknown> };
  const tick = async () => { internals.scanTopologies(); await internals.topologyWorker; };
  return { errors, tick };
}

describe('the consumer topology scan and its capability backoff', () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('a capability refusal from the scan is reported once and parks the scan', async () => {
    const { engine: seen, scans } = shaped(engine, { rustShape: true, scanError: capabilityMissing('raw_sql', 'fixture step') });
    const { errors, tick } = owner(seen);
    await tick();
    await tick();
    await tick();
    expect({ scans: scans.length, reports: errors.length, code: (errors[0] as { code?: string } | undefined)?.code })
      .toEqual({ scans: 1, reports: 1, code: 'engine_capability_missing' });
    expect(TOPOLOGY_STOP_BACKOFF_MS).toBe(600_000);
  });

  test('another scan error is reported and does not park the scan', async () => {
    const { engine: seen, scans } = shaped(engine, { rustShape: true, scanError: new Error('connection reset') });
    const { errors, tick } = owner(seen);
    await tick();
    await tick();
    expect({ scans: scans.length, reports: errors.length }).toEqual({ scans: 2, reports: 2 });
  });

  test.each([['with raw SQL', false], ['without raw SQL (the Rust shape)', true]] as const)(
    '%s the scan runs on every tick and reports nothing when no change is recovering', async (_label, rustShape) => {
      const { engine: seen, scans } = shaped(engine, { rustShape });
      const { errors, tick } = owner(seen);
      await tick();
      await tick();
      // An empty scan asks twice per tick: after its rotating cursor, then from the start (topology-recovery.ts).
      expect({ scans: scans.length, reports: errors.length }).toEqual({ scans: 4, reports: 0 });
    });
});
