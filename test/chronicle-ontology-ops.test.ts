/**
 * v0.42.x — Life Chronicle (#2390) ontology ops (Phase B.11).
 * Exercises the op handlers (not just the engine), with focus on the
 * privacy-critical remote diary-source redaction in ontology_get.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const SARAH = 'people/sarah-chen';
const ctx = (remote: boolean): OperationContext => ({ engine, remote, sourceId: 'default' } as unknown as OperationContext);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw('DELETE FROM facts'); });

describe('ontology ops', () => {
  test('ontology_propose writes; ontology_get reads back', async () => {
    const r = await operationsByName.ontology_propose.handler(ctx(false), {
      entity: SARAH, dimension: 'role', value: 'advisor', source: 'meetings/a',
    });
    expect((r as { action: string }).action).toBe('inserted');
    const got = await operationsByName.ontology_get.handler(ctx(false), { entity: SARAH }) as { dimension: string; value: string }[];
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ dimension: 'role', value: 'advisor' });
  });

  test('remote callers never see diary-sourced ontology', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'advisor', source: 'meetings/a' });
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'affect', value: 'anxious', source: 'life/diary/2026-06-18', status: 'active' });
    const local = await operationsByName.ontology_get.handler(ctx(false), { entity: SARAH, include_quarantined: true }) as { source: string }[];
    const remote = await operationsByName.ontology_get.handler(ctx(true), { entity: SARAH, include_quarantined: true }) as { source: string }[];
    expect(local.some((r) => (r.source ?? '').startsWith('life/diary/'))).toBe(true);
    expect(remote.some((r) => (r.source ?? '').startsWith('life/diary/'))).toBe(false);
  });

  test('remote ontology_conflicts redacts diary-sourced disagreement (codex fix #3)', async () => {
    // A conflict where one side is diary-sourced: advisor (meeting) vs founder (diary).
    await engine.mergeOntologyFact({ entitySlug: 'people/y', dimension: 'role', value: 'advisor', source: 'meetings/a', validFrom: '2026-05-01' });
    await engine.mergeOntologyFact({ entitySlug: 'people/y', dimension: 'role', value: 'founder', source: 'life/diary/2026-06-18', validFrom: '2026-01-01' });
    const local = await operationsByName.ontology_conflicts.handler(ctx(false), {}) as { entity_slug: string }[];
    expect(local.some((c) => c.entity_slug === 'people/y')).toBe(true);
    const remote = await operationsByName.ontology_conflicts.handler(ctx(true), {}) as { entity_slug: string }[];
    expect(remote.some((c) => c.entity_slug === 'people/y')).toBe(false); // diary side redacted → no longer a disagreement
  });

  test('ontology_dimensions + ontology_conflicts surface via ops', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'advisor', source: 'meetings/a', validFrom: '2026-05-01' });
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/b', validFrom: '2026-01-01' });
    const dims = await operationsByName.ontology_dimensions.handler(ctx(false), {}) as { dimension: string }[];
    expect(dims.some((d) => d.dimension === 'role')).toBe(true);
    const conflicts = await operationsByName.ontology_conflicts.handler(ctx(false), {}) as { dimension: string }[];
    expect(conflicts.some((c) => c.dimension === 'role')).toBe(true);
  });
});
