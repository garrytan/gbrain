/**
 * The owner's topology recovery scan (persistence/topology-recovery.ts `recoverSourceTopologies`) on an engine without
 * managed persistence.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on an engine whose capability set lacks `managed_persistence` (the Rust engine) the scan still runs its
 *    typed recovery read, finds nothing, returns 0 and sends no raw SQL; on PGLite and Postgres it reads
 *    persistence_topology_changes the same way.
 *  - Regression: the scan read persistence_topology_changes through executeRaw on every owner tick. On the Rust engine
 *    that refused raw_sql and ended the tick, so a CLI put on a Rust brain stayed write_pending.
 *    The scan then returned 0 before it read anything when managed_persistence was missing, so a recovering change on a
 *    claimed worktree of a Rust brain was never attempted or reported (test/engine-parity/worktree-terms.test.ts).
 *  - Why existing coverage misses it: the parity case (test/engine-parity/owner-recovery-scans.test.ts) compares the
 *    answers across arms, which cannot show that PGLite and Postgres still send the scan.
 *  - Seam: a proxy over the real engine that records executeRaw text; the Rust shape is that proxy with the Rust
 *    engine's missing capabilities removed and executeRaw refusing, as the Rust engine's does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { recoverSourceTopologies } from '../src/core/persistence/topology-recovery.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

/** The real engine, recording each executeRaw statement; `rustShape` drops managed_persistence and raw_sql and refuses raw SQL. */
function recording(engine: BrainEngine, rustShape: boolean) {
  const statements: string[] = [];
  const scans: unknown[][] = [];
  const capabilities = new Set([...engine.capabilities].filter(c => !rustShape || (c !== 'managed_persistence' && c !== 'raw_sql')));
  const proxy = new Proxy(engine, {
    get(target, key) {
      if (key === 'capabilities') return capabilities;
      if (key === 'listTopologyRecoveries') return async (...args: unknown[]) => {
        scans.push(args);
        return (target.listTopologyRecoveries as (...a: unknown[]) => unknown).apply(target, args);
      };
      if (key === 'executeRaw') return async (sql: string, ...rest: unknown[]) => {
        statements.push(sql);
        if (rustShape) throw capabilityMissing('raw_sql', 'executeRaw');
        return (target.executeRaw as (...args: unknown[]) => unknown).call(target, sql, ...rest);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine: proxy as BrainEngine, statements, scans };
}

for (const kind of testBackends()) {
  describe(`topology recovery scan without managed persistence (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
    }, 120_000);
    afterAll(async () => { await close(); });

    // The scan of persistence_topology_changes is the typed member listTopologyRecoveries now (the journal flip), so it
    // reaches the table through the engine, not through executeRaw.
    test('the engine itself still reads persistence_topology_changes and finds nothing to recover', async () => {
      const { engine: seen, statements, scans } = recording(engine, false);
      expect(await recoverSourceTopologies(seen, { hostId: randomUUID() })).toBe(0);
      expect(scans.length).toBeGreaterThanOrEqual(1);
      expect(statements.some(sql => sql.includes('persistence_topology_changes'))).toBe(false);
    });

    test('without managed_persistence the scan still reads through the typed member, returns 0 and sends no raw SQL', async () => {
      const { engine: seen, statements, scans } = recording(engine, true);
      expect(await recoverSourceTopologies(seen, { hostId: randomUUID() })).toBe(0);
      expect(statements).toEqual([]);
      expect(scans.length).toBeGreaterThanOrEqual(1);
    });
  });
}
