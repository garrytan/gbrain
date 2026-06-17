/**
 * v0.32.3 — `gbrain search modes/stats/tune` CLI tests.
 *
 * Covers dispatch + JSON output shape + idempotent --reset + recommendation
 * generation. Pure unit-level: bypasses the cli.ts entrypoint and calls
 * runSearch directly against a fresh PGLite engine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSearch } from '../src/commands/search.ts';
import { recordSearchTelemetry, _resetTelemetryWriterForTest, getTelemetryWriter } from '../src/core/search/telemetry.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';

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
  _resetTelemetryWriterForTest();
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'search.%' OR key LIKE 'models.%'`);
  await engine.executeRaw('DELETE FROM search_telemetry');
});

// Capture-stdout helper so we can assert command output without exec'ing.
async function captureRun(fn: () => Promise<void>): Promise<string> {
  const original = console.log;
  const captured: string[] = [];
  console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return captured.join('\n');
}

const makeMeta = (overrides: Partial<HybridSearchMeta> = {}): HybridSearchMeta => ({
  vector_enabled: true,
  detail_resolved: null,
  expansion_applied: false,
  intent: 'general',
  mode: 'balanced',
  ...overrides,
});

describe('gbrain search modes (read-only dashboard)', () => {
  test('--json emits structured report with all 3 bundles and active mode', async () => {
    await engine.setConfig('search.mode', 'tokenmax');
    const out = await captureRun(() => runSearch(engine, ['modes', '--json']));
    const report = JSON.parse(out);
    expect(report.schema_version).toBe(2);
    expect(report.active_mode).toBe('tokenmax');
    expect(report.active_mode_valid).toBe(true);
    expect(report.bundles.conservative.searchLimit).toBe(10);
    expect(report.bundles.balanced.searchLimit).toBe(25);
    expect(report.bundles.tokenmax.searchLimit).toBe(50);
    expect(report.resolved.tokenBudget.source).toBe('mode');
  });

  test('unset mode → balanced fallback with mode_valid=false', async () => {
    const out = await captureRun(() => runSearch(engine, ['modes', '--json']));
    const report = JSON.parse(out);
    expect(report.active_mode).toBe('balanced');
    expect(report.active_mode_valid).toBe(false);
    expect(report.resolved.searchLimit.source).toBe('fallback');
  });

  test('per-key override shows up with source=override', async () => {
    await engine.setConfig('search.mode', 'conservative');
    await engine.setConfig('search.cache.enabled', 'false');
    const out = await captureRun(() => runSearch(engine, ['modes', '--json']));
    const report = JSON.parse(out);
    expect(report.resolved.cache_enabled.value).toBe(false);
    expect(report.resolved.cache_enabled.source).toBe('override');
    // Other knobs still come from the mode bundle.
    expect(report.resolved.searchLimit.source).toBe('mode');
  });

  test('default text output names the active mode', async () => {
    await engine.setConfig('search.mode', 'tokenmax');
    const out = await captureRun(() => runSearch(engine, ['modes']));
    expect(out).toContain('tokenmax');
    expect(out).toContain('conservative');
    expect(out).toContain('balanced');
  });
});

describe('gbrain search modes --reset', () => {
  test('--source <mode> is a dry-run (no writes)', async () => {
    await engine.setConfig('search.cache.enabled', 'false');
    await engine.setConfig('search.tokenBudget', '4000');
    const out = await captureRun(() => runSearch(engine, ['modes', '--source', 'balanced']));
    expect(out).toContain('dry run');
    expect(out).toContain('search.cache.enabled');
    expect(out).toContain('search.tokenBudget');
    // Verify nothing was deleted.
    expect(await engine.getConfig('search.cache.enabled')).toBe('false');
    expect(await engine.getConfig('search.tokenBudget')).toBe('4000');
  });

  test('--reset clears every search.* override (but NOT search.mode itself)', async () => {
    await engine.setConfig('search.mode', 'conservative');
    await engine.setConfig('search.cache.enabled', 'false');
    await engine.setConfig('search.tokenBudget', '8000');
    await engine.setConfig('search.searchLimit', '15');
    await captureRun(() => runSearch(engine, ['modes', '--reset']));
    // Mode preserved; overrides gone.
    expect(await engine.getConfig('search.mode')).toBe('conservative');
    expect(await engine.getConfig('search.cache.enabled')).toBeNull();
    expect(await engine.getConfig('search.tokenBudget')).toBeNull();
    expect(await engine.getConfig('search.searchLimit')).toBeNull();
  });

  test('--reset on a clean install reports "no overrides"', async () => {
    const out = await captureRun(() => runSearch(engine, ['modes', '--reset']));
    expect(out).toContain('No search.* overrides set');
  });

  test('--reset preserves the upgrade-notice state key', async () => {
    await engine.setConfig('search.mode_upgrade_notice_shown', 'true');
    await engine.setConfig('search.tokenBudget', '4000');
    await captureRun(() => runSearch(engine, ['modes', '--reset']));
    // Notice key preserved (it's not an "override"); tokenBudget gone.
    expect(await engine.getConfig('search.mode_upgrade_notice_shown')).toBe('true');
    expect(await engine.getConfig('search.tokenBudget')).toBeNull();
  });
});

describe('gbrain search stats', () => {
  test('empty table → total_calls 0, message about no data', async () => {
    const out = await captureRun(() => runSearch(engine, ['stats']));
    expect(out).toContain('Total searches:');
    expect(out).toContain('0');
  });

  test('after telemetry writes → hit rate + intent mix surfaced', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'hit' } }), { results_count: 5 });
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'hit' } }), { results_count: 7 });
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'miss' } }), { results_count: 9 });
    recordSearchTelemetry(engine, makeMeta({ intent: 'entity' }), { results_count: 3 });
    await w.flush();

    const out = await captureRun(() => runSearch(engine, ['stats', '--json']));
    const stats = JSON.parse(out);
    expect(stats.total_calls).toBe(4);
    expect(stats.cache_hits).toBe(2);
    expect(stats.cache_misses).toBe(1);
    expect(stats.cache_hit_rate).toBeCloseTo(2 / 3, 3);
    expect(stats._meta.metric_glossary.cache_hit_rate).toBeDefined();
  });

  test('--days N clamps to [1, 365]', async () => {
    const out0 = await captureRun(() => runSearch(engine, ['stats', '--days', '0', '--json']));
    expect(JSON.parse(out0).window_days).toBe(1);
    const outBig = await captureRun(() => runSearch(engine, ['stats', '--days', '9999', '--json']));
    expect(JSON.parse(outBig).window_days).toBe(365);
  });
});

describe('gbrain search tune (recommendations)', () => {
  test('insufficient data → no_recommendations status', async () => {
    const out = await captureRun(() => runSearch(engine, ['tune', '--json']));
    const r = JSON.parse(out);
    expect(r.status).toBe('insufficient_data');
    expect(r.recommendations).toEqual([]);
  });

  test('conservative + high budget drop rate → recommends balanced', async () => {
    await engine.setConfig('search.mode', 'conservative');
    const w = getTelemetryWriter();
    w.setEngine(engine);
    // 30 calls, each dropping 5 results — strong signal.
    for (let i = 0; i < 30; i++) {
      recordSearchTelemetry(engine, makeMeta({
        mode: 'conservative',
        token_budget: { budget: 4000, used: 4000, kept: 5, dropped: 5 },
      }), { results_count: 5 });
    }
    await w.flush();

    const out = await captureRun(() => runSearch(engine, ['tune', '--json']));
    const r = JSON.parse(out);
    expect(r.status).toBe('has_recommendations');
    const modeRec = r.recommendations.find((x: { knob: string }) => x.knob === 'search.mode');
    expect(modeRec).toBeDefined();
    expect(modeRec.suggested).toBe('balanced');
  });

  test('tokenmax + Haiku subagent → recommends balanced', async () => {
    await engine.setConfig('search.mode', 'tokenmax');
    await engine.setConfig('models.tier.subagent', 'anthropic:claude-haiku-4-5');
    const w = getTelemetryWriter();
    w.setEngine(engine);
    for (let i = 0; i < 25; i++) {
      recordSearchTelemetry(engine, makeMeta({ mode: 'tokenmax' }), { results_count: 30 });
    }
    await w.flush();

    const out = await captureRun(() => runSearch(engine, ['tune', '--json']));
    const r = JSON.parse(out);
    const rec = r.recommendations.find((x: { knob: string; suggested: string }) =>
      x.knob === 'search.mode' && x.suggested === 'balanced'
    );
    expect(rec).toBeDefined();
    expect(rec.reason).toMatch(/Haiku/);
  });

  test('--apply mutates config', async () => {
    await engine.setConfig('search.mode', 'conservative');
    const w = getTelemetryWriter();
    w.setEngine(engine);
    for (let i = 0; i < 30; i++) {
      recordSearchTelemetry(engine, makeMeta({
        mode: 'conservative',
        token_budget: { budget: 4000, used: 4000, kept: 5, dropped: 5 },
      }), { results_count: 5 });
    }
    await w.flush();

    await captureRun(() => runSearch(engine, ['tune', '--apply']));
    expect(await engine.getConfig('search.mode')).toBe('balanced');
  });
});

describe('gbrain search dispatch', () => {
  test('--help shows usage', async () => {
    const out = await captureRun(() => runSearch(engine, ['--help']));
    expect(out).toContain('Usage:');
    expect(out).toContain('modes');
    expect(out).toContain('stats');
    expect(out).toContain('tune');
  });

  test('unknown subcommand exits 1', async () => {
    let exitCode = 0;
    const originalExit = process.exit;
    (process.exit as unknown as (code?: number) => void) = ((code?: number) => { exitCode = code ?? 0; throw new Error('exit-' + code); }) as never;
    const originalErr = console.error;
    console.error = () => { /* swallow */ };
    try {
      await runSearch(engine, ['nonsense']);
    } catch { /* expected */ }
    expect(exitCode).toBe(1);
    process.exit = originalExit;
    console.error = originalErr;
  });
});
