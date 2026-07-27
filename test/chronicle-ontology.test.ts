/**
 * v0.42.x — Life Chronicle (#2390) bi-temporal ontology on `facts` (Phase B.10).
 * PGLite in-memory. Covers insert / idempotent retry / corroboration / forward
 * supersession / --asof valid-time travel / quarantine / backdated-conflict
 * detection. The Postgres engine runs the identical SQL (see engine-parity).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
const SARAH = 'people/sarah-chen';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw('DELETE FROM facts'); });

describe('mergeOntologyFact + getOntology', () => {
  test('inserts a known dimension as active', async () => {
    const r = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a', validFrom: '2024-01-01' });
    expect(r.action).toBe('inserted');
    const o = await engine.getOntology(SARAH);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ dimension: 'role', value: 'founder', status: 'active' });
  });

  test('idempotent retry (same value + source) is a noop', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a' });
    const r = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a' });
    expect(r.action).toBe('noop');
    expect(await engine.getOntology(SARAH)).toHaveLength(1);
  });

  test('same value from a new source corroborates (still one current value)', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a' });
    const r = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/b' });
    expect(r.action).toBe('corroborated');
    const o = await engine.getOntology(SARAH);
    expect(o).toHaveLength(1);
    expect(o[0].value).toBe('founder');
  });

  test('normalizes dimension aliases (job_role → role)', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'job_role', value: 'advisor', source: 'meetings/a' });
    const o = await engine.getOntology(SARAH);
    expect(o[0].dimension).toBe('role');
  });

  test('forward supersession + --asof valid-time travel', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a', validFrom: '2024-01-01' });
    const r = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'advisor', source: 'meetings/b', validFrom: '2026-05-01' });
    expect(r.action).toBe('superseded_prior');
    // Current value is the new one…
    const now = await engine.getOntology(SARAH);
    expect(now[0].value).toBe('advisor');
    // …but as-of before the change, time-travel still sees the old one.
    const past = await engine.getOntology(SARAH, { asof: '2025-01-01' });
    expect(past[0].value).toBe('founder');
  });

  test('novel dimensions quarantine (excluded from current unless asked)', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'vibe', value: 'chaotic', source: 'meetings/a' });
    expect(await engine.getOntology(SARAH)).toHaveLength(0); // quarantined → hidden
    const incl = await engine.getOntology(SARAH, { includeQuarantined: true });
    expect(incl).toHaveLength(1);
    expect(incl[0].status).toBe('quarantined');
  });
});

describe('findOntologyConflicts + discoverOntologyDimensions', () => {
  test('backdated conflicting value is NOT rewritten and surfaces as a conflict', async () => {
    const BOB = 'people/bob';
    await engine.mergeOntologyFact({ entitySlug: BOB, dimension: 'role', value: 'advisor', source: 'meetings/a', validFrom: '2026-05-01' });
    const r = await engine.mergeOntologyFact({ entitySlug: BOB, dimension: 'role', value: 'founder', source: 'meetings/b', validFrom: '2026-01-01' });
    expect(r.action).toBe('inserted'); // backdated → not a supersession
    const conflicts = await engine.findOntologyConflicts();
    const bobRole = conflicts.find((c) => c.entity_slug === BOB && c.dimension === 'role');
    expect(bobRole).toBeTruthy();
    expect(bobRole!.values.map((v) => v.value).sort()).toEqual(['advisor', 'founder']);
  });

  test('forward supersession is NOT reported as a conflict (only live disagreement is)', async () => {
    // founder (2024) → advisor (2026): the founder row is closed via valid_until,
    // so it must NOT count as a current conflict (codex pre-landing fix #1).
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'm/a', validFrom: '2024-01-01' });
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'advisor', source: 'm/b', validFrom: '2026-05-01' });
    const conflicts = await engine.findOntologyConflicts();
    expect(conflicts.some((c) => c.entity_slug === SARAH && c.dimension === 'role')).toBe(false);
  });

  test('discoverOntologyDimensions rolls up by dimension', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a' });
    await engine.mergeOntologyFact({ entitySlug: 'people/bob', dimension: 'role', value: 'advisor', source: 'meetings/b' });
    const dims = await engine.discoverOntologyDimensions();
    const role = dims.find((d) => d.dimension === 'role');
    expect(role).toBeTruthy();
    expect(role!.entities).toBe(2);
  });

  test('source isolation: ontology is scoped by source_id', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a', sourceId: 'default' });
    expect(await engine.getOntology(SARAH, { sourceId: 'default' })).toHaveLength(1);
    expect(await engine.getOntology(SARAH, { sourceId: 'other' })).toHaveLength(0);
  });
});
