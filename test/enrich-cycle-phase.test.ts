/**
 * v0.41.39 (#1700) — `enrich_thin` cycle phase tests.
 *
 * Hermetic: drives `runPhaseEnrichThin` against PGLite. The dry-run path
 * exercises candidate enumeration + per-source caps WITHOUT a chat gateway
 * (dry-run never calls the LLM), so no API key / no mock.module is needed.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseEnrichThin } from '../src/core/cycle/enrich-thin.ts';

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
  await resetPgliteState(engine);
});

async function seedStub(slug: string, title: string) {
  await engine.putPage(slug, {
    type: 'person' as never,
    title,
    compiled_truth: 'Stub page.',
    timeline: '',
    frontmatter: {},
  });
}

describe('runPhaseEnrichThin', () => {
  test('disabled by default → skipped with enable hint', async () => {
    const r = await runPhaseEnrichThin(engine, {});
    expect(r.status).toBe('skipped');
    expect(r.details.reason).toBe('disabled');
    expect(String(r.details.enable_hint)).toContain('cycle.enrich_thin.enabled true');
  });

  test('enabled with no thin pages → ok, nothing enriched (dry-run, no spend)', async () => {
    await engine.setConfig('cycle.enrich_thin.enabled', 'true');
    // No stub pages seeded → zero candidates; dry-run never calls the LLM, so
    // this is deterministic regardless of whether a chat gateway is configured.
    const r = await runPhaseEnrichThin(engine, { dryRun: true });
    expect(r.status).toBe('ok');
    const perSource = r.details.per_source as Record<string, { pages_enriched: number; candidates_considered: number }>;
    expect(perSource['default'].pages_enriched).toBe(0);
    expect(perSource['default'].candidates_considered).toBe(0);
  });

  test('enabled + dry-run respects max_pages_per_tick cap', async () => {
    await engine.setConfig('cycle.enrich_thin.enabled', 'true');
    await engine.setConfig('cycle.enrich_thin.max_pages_per_tick', '2');
    for (let i = 0; i < 5; i++) await seedStub(`people/p${i}-example`, `P${i} Example`);

    const r = await runPhaseEnrichThin(engine, { dryRun: true });
    expect(r.status).toBe('ok');
    const perSource = r.details.per_source as Record<string, { candidates_considered: number; pages_enriched: number }>;
    const def = perSource['default'];
    expect(def).toBeTruthy();
    // Cap of 2 applied at the SQL limit; never enumerates all 5.
    expect(def.candidates_considered).toBeLessThanOrEqual(2);
    // dry-run never writes.
    expect(def.pages_enriched).toBe(0);

    // Pages remain stubs (no writes in dry-run).
    const page = await engine.getPage('people/p0-example', { sourceId: 'default' });
    expect(page!.compiled_truth.trim()).toBe('Stub page.');
  });

  test('details carry config knobs for observability', async () => {
    await engine.setConfig('cycle.enrich_thin.enabled', 'true');
    await engine.setConfig('cycle.enrich_thin.order', 'updated');
    const r = await runPhaseEnrichThin(engine, { dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.details.order).toBe('updated');
    expect(r.details.max_pages_per_tick).toBe(3); // default
    expect(Array.isArray(r.details.types)).toBe(true);
  });

  test('per-source max_cost_usd is read and surfaced (P2#2)', async () => {
    // Before Fix E, max_cost_usd was parsed into cfg but never passed to
    // runEnrichCore nor surfaced — one source could drain the whole tick.
    // Now it's the per-source ceiling (min(per_source, brain_wide_remaining))
    // and appears in details. Defaults: per-source 1.0, brain-wide 5.0.
    await engine.setConfig('cycle.enrich_thin.enabled', 'true');
    await engine.setConfig('cycle.enrich_thin.max_cost_usd', '0.5');
    const r = await runPhaseEnrichThin(engine, { dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.details.max_cost_usd).toBe(0.5);
    expect(r.details.max_total_cost_usd).toBe(5.0); // brain-wide default unchanged
  });
});
