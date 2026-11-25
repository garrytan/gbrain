/**
 * The owner's topology recovery scan in the persistence consumer (persistence/consumer.ts `scanTopologies`) against a
 * capability stop.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: when the scan meets a capability refusal (an engine that does not hold managed worktrees refuses a
 *    topology member by name), the first scan reports it once and parks the scan for TOPOLOGY_STOP_BACKOFF_MS: the next
 *    tick neither scans nor reports again, and it does not throw. Any other scan error is reported and the next tick
 *    scans again, as before. A scan that finds nothing runs every tick.
 *  - Regression: a refusing scan was asked again each tick and reported on every one.
 *  - Why existing coverage misses it: the parity cases (test/engine-parity/topology-named-stop.test.ts,
 *    managed-recovery-on-rust.test.ts) run the scan function itself; the consumer's tick wiring and its backoff are only
 *    reachable through the consumer. The topology recovery no longer stops by name on the Rust engine (it runs on the
 *    typed topology store), so the refusal here is the one a user's Rust brain gives while managed mode is held back.
 *  - Seam: a proxy over a real PGLite engine; its recovery list answers one recovering change, or throws the refusal.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { PersistenceConsumer, TOPOLOGY_STOP_BACKOFF_MS } from '../src/core/persistence/consumer.ts';

const RECOVERING = { id: randomUUID(), principal_id: randomUUID(), request_id: randomUUID(), digest: 'e'.repeat(64), operation: 'reclone',
  source_id: 'work', source_incarnation: randomUUID(), worktree_ids: [], state: 'recovering', recovery: { worktreeId: randomUUID() },
  recovery_bytes: 0, intent_bytes: 0, terminal_bytes: 0, outcome: null };

/** The real engine; `rustShape` answers one recovering change from the list; `scanError` makes the list throw it. */
function shaped(engine: BrainEngine, opts: { rustShape: boolean; scanError?: Error }) {
  const scans: unknown[][] = [];
  const capabilities = new Set([...engine.capabilities]);
  const proxy = new Proxy(engine, {
    get(target, key) {
      if (key === 'capabilities') return capabilities;
      if (key === 'listTopologyRecoveries') return async (...args: unknown[]) => {
        scans.push(args);
        if (opts.scanError) throw opts.scanError;
        return opts.rustShape ? [RECOVERING] : (target.listTopologyRecoveries as (...a: unknown[]) => unknown).apply(target, args);
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

describe('the consumer topology scan and a capability stop', () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('a capability refusal is reported once and parks the scan', async () => {
    const { engine: seen, scans } = shaped(engine, { rustShape: true, scanError: capabilityMissing('managed_persistence', 'topologyStore (a step of the topology recovery)') });
    const { errors, tick } = owner(seen);
    await tick();
    await tick();
    await tick();
    const detail = (errors[0] as { detail?: string } | undefined)?.detail ?? '';
    expect({ scans: scans.length, reports: errors.length, code: (errors[0] as { code?: string } | undefined)?.code,
      member: /member=(\w+)/.exec(detail)?.[1], written: /written=(\w+)/.exec(detail)?.[1] })
      .toEqual({ scans: 1, reports: 1, code: 'engine_capability_missing', member: 'topologyStore', written: 'nothing' });
    expect(TOPOLOGY_STOP_BACKOFF_MS).toBe(600_000);
  });

  test('another scan error is reported and does not park the scan', async () => {
    const { engine: seen, scans } = shaped(engine, { rustShape: true, scanError: new Error('connection reset') });
    const { errors, tick } = owner(seen);
    await tick();
    await tick();
    expect({ scans: scans.length, reports: errors.length }).toEqual({ scans: 2, reports: 2 });
  });

  test('a scan that finds nothing runs on every tick and reports nothing', async () => {
    const { engine: seen, scans } = shaped(engine, { rustShape: false });
    const { errors, tick } = owner(seen);
    await tick();
    await tick();
    // An empty scan asks twice per tick: after its rotating cursor, then from the start (topology-recovery.ts).
    expect({ scans: scans.length, reports: errors.length }).toEqual({ scans: 4, reports: 0 });
  });
});
