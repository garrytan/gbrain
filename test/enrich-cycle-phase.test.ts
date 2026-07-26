import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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

async function seedStub(slug: string, title: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'person' as never,
    title,
    compiled_truth: 'Stub page.',
    timeline: '',
    frontmatter: {},
  });
}

describe('runPhaseEnrichThin', () => {
  test('is disabled by default', async () => {
    const result = await runPhaseEnrichThin(engine, {});
    expect(result.status).toBe('skipped');
    expect(result.details.reason).toBe('disabled');
  });

  test('dry-run respects the per-tick page cap without writing', async () => {
    await engine.setConfig('cycle.enrich_thin.enabled', 'true');
    await engine.setConfig('cycle.enrich_thin.max_pages_per_tick', '2');
    for (let i = 0; i < 5; i++) {
      await seedStub(`people/p${i}-example`, `P${i} Example`);
    }

    const result = await runPhaseEnrichThin(engine, { dryRun: true });
    expect(result.status).toBe('ok');
    const perSource = result.details.per_source as Record<
      string,
      { candidates_considered: number; pages_enriched: number }
    >;
    expect(perSource.default.candidates_considered).toBeLessThanOrEqual(2);
    expect(perSource.default.pages_enriched).toBe(0);
    expect((await engine.getPage('people/p0-example'))!.compiled_truth.trim()).toBe('Stub page.');
  });

  test('surfaces budget and ordering knobs', async () => {
    await engine.setConfig('cycle.enrich_thin.enabled', 'true');
    await engine.setConfig('cycle.enrich_thin.max_cost_usd', '0.5');
    await engine.setConfig('cycle.enrich_thin.order', 'updated');
    const result = await runPhaseEnrichThin(engine, { dryRun: true });
    expect(result.status).toBe('ok');
    expect(result.details.max_cost_usd).toBe(0.5);
    expect(result.details.order).toBe('updated');
  });
});
