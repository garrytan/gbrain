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
import { __setChatTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';

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
  resetGateway();
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
  test('disabled by default → skipped with enable hint, even with a chat key configured', async () => {
    for (const withKey of [false, true]) {
      resetGateway();
      if (withKey) __setChatTransportForTests(async () => { throw new Error('no chat call expected'); });
      const r = await runPhaseEnrichThin(engine, {});
      expect(r.status).toBe('skipped');
      expect(r.details.reason).toBe('disabled');
      expect(String(r.details.enable_hint)).toContain('cycle.enrich_thin.enabled true');
    }
  });

  test('a stored true runs with a $0.50 brain-wide cap and 3 pages per source, and no daily cap (dry-run)', async () => {
    await engine.setConfig('cycle.enrich_thin.enabled', 'true');
    const r = await runPhaseEnrichThin(engine, { dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.details).toMatchObject({ max_total_cost_usd: 0.5, max_pages_per_tick: 3, max_cost_usd: 1 });
    expect(r.details.daily).toMatchObject({ max_daily_cost_usd: 'off', max_daily_pages: 'off' });
    await engine.setConfig('cycle.enrich_thin.enabled', 'false');
    expect((await runPhaseEnrichThin(engine, {})).details.reason).toBe('disabled');
  });

  test('stored caps are kept: an explicit brain-wide cap is not replaced by the new default', async () => {
    await engine.setConfig('cycle.enrich_thin.enabled', 'true');
    await engine.setConfig('cycle.enrich_thin.max_total_cost_usd', '5');
    await engine.setConfig('cycle.enrich_thin.max_pages_per_tick', '7');
    const r = await runPhaseEnrichThin(engine, { dryRun: true });
    expect(r.details).toMatchObject({ max_total_cost_usd: 5, max_pages_per_tick: 7 });
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
    // and appears in details. Defaults: per-source 1.0, brain-wide 0.5.
    await engine.setConfig('cycle.enrich_thin.enabled', 'true');
    await engine.setConfig('cycle.enrich_thin.max_cost_usd', '0.5');
    const r = await runPhaseEnrichThin(engine, { dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.details.max_cost_usd).toBe(0.5);
    expect(r.details.max_total_cost_usd).toBe(0.5); // brain-wide default unchanged
  });

  test("#2504: max_cost_usd accepts 'off' (uncapped per-source; brain-wide still governs)", async () => {
    // parseFloat('off') is NaN — the operator's explicit opt-out used to be
    // silently replaced with the $1 default. Same off/unlimited/none spellings
    // as `gbrain enrich --max-usd`.
    await engine.setConfig('cycle.enrich_thin.enabled', 'true');
    await engine.setConfig('cycle.enrich_thin.max_cost_usd', 'off');
    const r = await runPhaseEnrichThin(engine, { dryRun: true });
    expect(r.status).toBe('ok');
    // Details report the operator's spelling, never Infinity→null.
    expect(r.details.max_cost_usd).toBe('off');
    expect(r.details.max_total_cost_usd).toBe(0.5);
  });

  test("#2504: both cost knobs 'off' still runs (fully uncapped tick)", async () => {
    await engine.setConfig('cycle.enrich_thin.enabled', 'true');
    await engine.setConfig('cycle.enrich_thin.max_cost_usd', 'off');
    await engine.setConfig('cycle.enrich_thin.max_total_cost_usd', 'unlimited');
    const r = await runPhaseEnrichThin(engine, { dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.details.max_cost_usd).toBe('off');
    expect(r.details.max_total_cost_usd).toBe('off');
    // The per-source loop actually processed the default source (Infinity
    // remaining never breaks the loop before work happens).
    const perSource = r.details.per_source as Record<string, unknown>;
    expect(perSource['default']).toBeTruthy();
  });
});
