/**
 * v0.35.4 — find_trajectory MCP op (T5) tests.
 *
 * Pins:
 *   - Param validation: entity_slug required, non-empty.
 *   - Visibility filter on remote=true callers (R6 / D-CDX-1).
 *   - Source scoping via sourceScopeOpts (federated vs scalar).
 *   - Stable JSON envelope: points + regressions + drift_score + schema_version=1 (R5).
 *   - Engine result's raw Float32Array embedding is NOT serialized to wire.
 *   - Empty-result graceful shape (G1).
 *   - The op is registered + read-scope + not localOnly.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM facts WHERE entity_slug LIKE 'optraj-%'`);
  await engine.executeRaw(`DELETE FROM sources WHERE id LIKE 'optraj-%'`);
});

function unitVec(idx: number): string {
  const a = new Float32Array(1536);
  a[idx % 1536] = 1.0;
  return '[' + Array.from(a).join(',') + ']';
}

async function insertTyped(args: {
  source_id?: string;
  entity_slug: string;
  metric: string;
  value: number;
  valid_from: Date;
  visibility?: 'private' | 'world';
  vecIdx?: number;
}): Promise<void> {
  const sid = args.source_id ?? 'default';
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`,
    [sid],
  );
  await engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from,
                        claim_metric, claim_value, claim_unit, claim_period,
                        visibility, embedding, embedded_at)
     VALUES ($1, $2, $3, 'fact', 'test', $4::timestamptz,
             $5, $6, 'USD', 'monthly',
             $7, $8::vector, $4::timestamptz)`,
    [
      sid, args.entity_slug, `${args.metric} = ${args.value}`,
      args.valid_from.toISOString(), args.metric, args.value,
      args.visibility ?? 'private', unitVec(args.vecIdx ?? 0),
    ],
  );
}

function mkCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as any,
    dryRun: false,
    remote: false,
    ...overrides,
  } as OperationContext;
}

describe('find_trajectory MCP op — registration + shape', () => {
  test('registered with read scope, NOT localOnly', () => {
    const op = operationsByName['find_trajectory'];
    expect(op).toBeDefined();
    expect(op.scope).toBe('read');
    expect(op.localOnly).toBeUndefined();
    // Description references the v0.35.4 contract.
    expect(op.description).toContain('schema_version');
  });

  test('throws on missing entity_slug', async () => {
    const op = operationsByName['find_trajectory'];
    await expect(op.handler(mkCtx(), {})).rejects.toThrow(/entity_slug/);
    await expect(op.handler(mkCtx(), { entity_slug: '' })).rejects.toThrow(/entity_slug/);
    await expect(op.handler(mkCtx(), { entity_slug: '   ' })).rejects.toThrow(/entity_slug/);
  });

  test('returns stable JSON shape with schema_version: 1', async () => {
    await insertTyped({ entity_slug: 'optraj-shape', metric: 'mrr', value: 50000, valid_from: new Date('2026-01-15') });
    const op = operationsByName['find_trajectory'];
    const result = await op.handler(mkCtx(), { entity_slug: 'optraj-shape' }) as any;
    expect(result).toHaveProperty('points');
    expect(result).toHaveProperty('regressions');
    expect(result).toHaveProperty('drift_score');
    expect(result.schema_version).toBe(1);
    // Embedding NOT serialized to the wire.
    expect(result.points[0]).not.toHaveProperty('embedding');
    // valid_from is YYYY-MM-DD string.
    expect(result.points[0].valid_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('unknown entity returns graceful empty shape (G1)', async () => {
    const op = operationsByName['find_trajectory'];
    const result = await op.handler(mkCtx(), { entity_slug: 'optraj-does-not-exist' }) as any;
    expect(result.points).toEqual([]);
    expect(result.regressions).toEqual([]);
    expect(result.drift_score).toBeNull();
    expect(result.schema_version).toBe(1);
  });
});

describe('find_trajectory MCP op — visibility filter (R6 / D-CDX-1)', () => {
  test('remote=true sees only world-visibility points', async () => {
    await insertTyped({ entity_slug: 'optraj-vis', metric: 'mrr', value: 50000, visibility: 'private', valid_from: new Date('2026-01-15') });
    await insertTyped({ entity_slug: 'optraj-vis', metric: 'mrr', value: 99999, visibility: 'world',   valid_from: new Date('2026-04-12') });

    const op = operationsByName['find_trajectory'];
    const local  = await op.handler(mkCtx({ remote: false }), { entity_slug: 'optraj-vis' }) as any;
    expect(local.points.length).toBe(2);

    const remote = await op.handler(mkCtx({ remote: true  }), { entity_slug: 'optraj-vis' }) as any;
    expect(remote.points.length).toBe(1);
    expect(remote.points[0].value).toBe(99999);
  });
});

describe('find_trajectory MCP op — source scoping (D-CDX-6)', () => {
  test('federated sourceIds from auth.allowedSources narrows scope', async () => {
    await insertTyped({ source_id: 'optraj-A', entity_slug: 'optraj-fed', metric: 'mrr', value: 1, valid_from: new Date('2026-01-15') });
    await insertTyped({ source_id: 'optraj-B', entity_slug: 'optraj-fed', metric: 'mrr', value: 2, valid_from: new Date('2026-04-12') });
    await insertTyped({ source_id: 'optraj-C', entity_slug: 'optraj-fed', metric: 'mrr', value: 3, valid_from: new Date('2026-07-08') });

    const op = operationsByName['find_trajectory'];
    const ctx = mkCtx({
      auth: { allowedSources: ['optraj-A', 'optraj-B'] } as any,
    });
    const result = await op.handler(ctx, { entity_slug: 'optraj-fed' }) as any;
    expect(result.points.length).toBe(2);
    expect(result.points.map((p: any) => p.value)).toEqual([1, 2]);
  });

  test('scalar ctx.sourceId narrows to that single source', async () => {
    await insertTyped({ source_id: 'optraj-X', entity_slug: 'optraj-scalar', metric: 'mrr', value: 100, valid_from: new Date('2026-01-15') });
    await insertTyped({ source_id: 'optraj-Y', entity_slug: 'optraj-scalar', metric: 'mrr', value: 200, valid_from: new Date('2026-01-15') });

    const op = operationsByName['find_trajectory'];
    const ctx = mkCtx({ sourceId: 'optraj-X' });
    const result = await op.handler(ctx, { entity_slug: 'optraj-scalar' }) as any;
    expect(result.points.length).toBe(1);
    expect(result.points[0].value).toBe(100);
  });
});

describe('find_trajectory MCP op — regression + drift surface', () => {
  test('regressions populate when newer value drops >= 10% (D-ENG-2 default)', async () => {
    await insertTyped({ entity_slug: 'optraj-reg', metric: 'mrr', value: 200000, valid_from: new Date('2026-04-12'), vecIdx: 0 });
    await insertTyped({ entity_slug: 'optraj-reg', metric: 'mrr', value: 150000, valid_from: new Date('2026-07-08'), vecIdx: 0 });

    const op = operationsByName['find_trajectory'];
    const result = await op.handler(mkCtx(), { entity_slug: 'optraj-reg' }) as any;
    expect(result.regressions.length).toBe(1);
    expect(result.regressions[0].metric).toBe('mrr');
    expect(result.regressions[0].delta_pct).toBeCloseTo(-0.25, 3);
  });

  test('drift_score returns null with <3 embedded points (G3)', async () => {
    await insertTyped({ entity_slug: 'optraj-drift', metric: 'mrr', value: 1, valid_from: new Date('2026-01-15') });
    await insertTyped({ entity_slug: 'optraj-drift', metric: 'mrr', value: 2, valid_from: new Date('2026-04-12') });

    const op = operationsByName['find_trajectory'];
    const result = await op.handler(mkCtx(), { entity_slug: 'optraj-drift' }) as any;
    expect(result.drift_score).toBeNull();
  });
});
