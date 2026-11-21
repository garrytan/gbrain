/**
 * The three writer-status reads that are still raw SQL (stalled catch-ups, parked groups, source movement) refuse by
 * name on an engine without raw SQL (the Rust engine), before any statement runs. An engine with raw SQL, or a handle
 * that reports no capability set, still runs the read.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { readStalledCatchups } from '../src/core/persistence/effect-catchup.ts';
import { readParkedGroups } from '../src/core/persistence/parked-groups.ts';
import { readSourceMovement } from '../src/core/persistence/sync-movement.ts';

function fake(capabilities: string[] | null) {
  const sql: string[] = [];
  const engine = {
    ...(capabilities ? { capabilities: new Set(capabilities) } : {}),
    executeRaw: async (statement: string) => { sql.push(statement); return []; },
  } as unknown as BrainEngine;
  return { engine, sql };
}

const READS: Array<[string, string, (engine: BrainEngine) => Promise<unknown>]> = [
  ['stalled catch-ups', 'stalled_catchups_read', engine => readStalledCatchups(engine)],
  ['parked groups', 'parked_groups_read', engine => readParkedGroups(engine)],
  ['source movement', 'source_movement_read', engine => readSourceMovement(engine)],
];

describe('writer-status reads that are still raw SQL', () => {
  for (const [name, member, read] of READS) {
    test(`${name} refuse by name on an engine without raw_sql, and run no statement`, async () => {
      const { engine, sql } = fake(['pages']);
      const refusal = await read(engine).then(() => null, (e: { code?: string; reason?: string; detail?: string }) => e);
      expect(refusal?.code).toBe('engine_capability_missing');
      expect(refusal?.detail).toBe(`member=${member} capability=raw_sql outcome=none written=nothing`);
      expect(sql).toEqual([]);
    });

    test(`${name} still run on an engine with raw_sql and on a handle without a capability set`, async () => {
      for (const caps of [['raw_sql'], null]) {
        const { engine, sql } = fake(caps);
        expect(await read(engine)).toEqual([]);
        expect(sql.length).toBe(1);
      }
    });
  }
});
