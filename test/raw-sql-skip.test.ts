/**
 * An engine without raw SQL (the Rust engine, D18) has no persistence custody
 * tables and no query planner. The startup persistence reads and the planner
 * statistics upkeep answer "no rows" / "nothing to analyze" on it without one
 * `executeRaw` call, instead of refusing the command. PGLite reports `raw_sql`,
 * so each control below runs its SQL as before. Synthetic names only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { ENGINE_CAPABILITIES, lacksRawSql, type Capability } from '../src/core/engine-capabilities.ts';
import { cleanupRetiredManagedMarkers } from '../src/core/persistence/deactivation.ts';
import { segmentedGateEvidence } from '../src/core/persistence/writer-versions.ts';
import { readGraduationConnectRow } from '../src/core/persistence/graduation-schema.ts';
import { analyzePlannerTables, beginFullAnalyze, maybeRefreshPlannerStats, readPlannerStatsState } from '../src/core/planner-stats.ts';
import { canAnalyzePages, refreshProjectionStatistics } from '../src/core/search/projection-statistics.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

const RAW_SQL_MEMBERS = new Set<PropertyKey>(['executeRaw', 'executeRawDirect', 'withReservedConnection']);

/**
 * The PGLite engine seen through a counter of raw-SQL calls. `rawSql: false` drops `raw_sql` from its capabilities
 * and makes every raw-SQL member refuse, as the Rust engine does. Its kind stays `pglite`, so a skip is proven by the
 * capability, not by an engine-kind branch.
 */
function counted(rawSql: boolean): { engine: BrainEngine; calls: () => number } {
  let calls = 0;
  const capabilities = new Set<Capability>(ENGINE_CAPABILITIES.filter(c => rawSql || c !== 'raw_sql'));
  const proxy = new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === 'capabilities') return capabilities;
      if (RAW_SQL_MEMBERS.has(prop)) {
        const real = Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown;
        return async (...args: unknown[]) => {
          calls++;
          if (!rawSql) throw capabilityMissing('raw_sql', String(prop));
          return real.apply(target, args);
        };
      }
      if (prop === 'transaction') {
        return async (fn: (tx: BrainEngine) => Promise<unknown>) => {
          if (!rawSql) { calls++; throw capabilityMissing('raw_sql', 'transaction'); }
          return target.transaction(fn);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
  return { engine: proxy, calls: () => calls };
}

describe('lacksRawSql', () => {
  test('is true only for a capability set without raw_sql', () => {
    expect(lacksRawSql(counted(false).engine)).toBe(true);
    expect(lacksRawSql(counted(true).engine)).toBe(false);
    expect(lacksRawSql(engine)).toBe(false);
    // A transaction handle or test double without a capability set runs its SQL as before.
    expect(lacksRawSql({ executeRaw: async () => [] })).toBe(false);
  });
});

describe('startup persistence reads on an engine without raw SQL', () => {
  test('the graduation connect row reads as no row', async () => {
    const rust = counted(false);
    expect(await readGraduationConnectRow(rust.engine)).toBeNull();
    expect(rust.calls()).toBe(0);
  });

  test('retired managed-marker cleanup has nothing to clean', async () => {
    const rust = counted(false);
    expect(await cleanupRetiredManagedMarkers(rust.engine)).toEqual({ state: 'cleared', removed: [], pending: [] });
    expect(rust.calls()).toBe(0);
  });

  test('the segmented-gate writer evidence is empty', async () => {
    const rust = counted(false);
    expect(await segmentedGateEvidence(rust.engine, 7)).toEqual([]);
    expect(rust.calls()).toBe(0);
  });

  test('control: PGLite runs the same reads through executeRaw', async () => {
    const pglite = counted(true);
    expect(await cleanupRetiredManagedMarkers(pglite.engine)).toEqual({ state: 'cleared', removed: [], pending: [] });
    expect(Array.isArray(await segmentedGateEvidence(pglite.engine, 7))).toBe(true);
    expect(pglite.calls()).toBeGreaterThanOrEqual(2);
  });
});

describe('planner statistics on an engine without raw SQL', () => {
  test('the planner-stats state reads as unavailable, and nothing is analyzed', async () => {
    const rust = counted(false);
    expect(await readPlannerStatsState(rust.engine)).toBeNull();
    expect(await analyzePlannerTables(rust.engine, ['pages'], 'import')).toEqual([]);
    const publish = await beginFullAnalyze(rust.engine);
    await publish();
    const refresh = await maybeRefreshPlannerStats(rust.engine, 'import', { throttle: false });
    expect(refresh.analyzed).toEqual([]);
    expect(refresh.skipped).toBe('unavailable');
    expect(rust.calls()).toBe(0);
  });

  test('the projection statistics refresh succeeds with nothing to analyze and prints no warning', async () => {
    const rust = counted(false);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await canAnalyzePages(rust.engine)).toBe(false);
      expect(await refreshProjectionStatistics(rust.engine, 1)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(rust.calls()).toBe(0);
  });

  test('control: PGLite reads its planner state and analyzes', async () => {
    const pglite = counted(true);
    expect(Array.isArray(await readPlannerStatsState(pglite.engine))).toBe(true);
    expect(await canAnalyzePages(pglite.engine)).toBe(true);
    expect(await refreshProjectionStatistics(pglite.engine)).toBe(true);
    expect(pglite.calls()).toBeGreaterThan(0);
  });
});
