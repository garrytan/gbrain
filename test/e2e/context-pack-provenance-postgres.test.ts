/**
 * #6146 Postgres arm: `context_pack` and `delta` read each delivered fact's
 * stored provenance in one batched lookup (`facts.id = ANY($2::bigint[])`).
 * Postgres returns bigint ids through its own driver path, so this pins that
 * `fact_id` and `provenance` come back the same as on PGLite
 * (test/context-pack-fact-traceability.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { __resetHotMemoryCacheForTests } from '../../src/core/facts/meta-hook.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: BrainEngine;
const noop = { info: () => {}, warn: () => {}, error: () => {} };
const local = (): OperationContext => ({ engine, config: {} as GBrainConfig, logger: noop, dryRun: false, remote: false, sourceId: 'default' }) as OperationContext;

beforeAll(async () => {
  if (skip) return;
  engine = await setupDB();
  await engine.insertFact({ fact: 'Project Boreal-pg uses the colour green.', entity_slug: 'projects/boreal-pg-example', source: 'PG-PROVENANCE-1', visibility: 'world', embedding: null } as never, { source_id: 'default' });
});

afterAll(async () => {
  if (skip) return;
  await teardownDB();
});

describeIfDB('#6146 context_pack and delta provenance on Postgres', () => {
  for (const [name, args] of [
    ['context_pack', () => ({ entities: 'projects/boreal-pg-example', session_id: randomUUID() })],
    ['delta', () => ({ since: '2000-01-01T00:00:00Z' })],
  ] as const) {
    test(`${name}: fact_id matches recall and provenance is the stored source`, async () => {
      __resetHotMemoryCacheForTests();
      const recalled = await operationsByName.recall!.handler(local(), { entity: 'projects/boreal-pg-example' }) as { facts: Array<{ id: number }> };
      const body = await operationsByName[name]!.handler(local(), args()) as { facts: Array<{ fact: string; fact_id: string; provenance: string | null }> };
      const fact = body.facts.find(f => f.fact.startsWith('Project Boreal-pg'))!;
      expect(fact.fact_id).toBe(String(recalled.facts[0]!.id));
      expect(fact.provenance).toBe('PG-PROVENANCE-1');
    });
  }
});
