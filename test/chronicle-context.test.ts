/**
 * v0.42.x — Life Chronicle (#2390) agent-context loader (Phase B.12).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadChronicleContext } from '../src/core/context/chronicle-context.ts';

let engine: PGLiteEngine;
const SARAH = 'people/sarah-chen';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  // An entity with a public role + a diary-sourced affect.
  await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'advisor', source: 'meetings/a' });
  await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'affect', value: 'anxious', source: 'life/diary/2026-06-18', status: 'active' });
});
afterAll(async () => { await engine.disconnect(); });

describe('loadChronicleContext', () => {
  test('bundles recent timeline + resolved ontology for named entities', async () => {
    const ctx = await loadChronicleContext(engine, { days: 30, entities: [SARAH], remote: false });
    expect(ctx.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Array.isArray(ctx.recent_timeline)).toBe(true);
    expect(ctx.ontologies[SARAH].map((v) => v.dimension).sort()).toEqual(['affect', 'role']);
  });

  test('redacts diary-sourced ontology for remote callers', async () => {
    const ctx = await loadChronicleContext(engine, { entities: [SARAH], remote: true });
    const dims = (ctx.ontologies[SARAH] ?? []).map((v) => v.dimension);
    expect(dims).toContain('role');
    expect(dims).not.toContain('affect'); // diary-sourced → redacted remotely
  });
});
