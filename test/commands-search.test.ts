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
import { recordSearchTelemetry, _resetTelemetryWriterForTest, getTelemetryWriter, TELEMETRY_COVERAGE_CAVEAT } from '../src/core/search/telemetry.ts';
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

  // Coverage disclosure: short-lived CLI search calls typically don't
  // survive the telemetry flush timer/threshold, so `search stats` must
  // say so instead of presenting the (possibly CLI-blind) count as total.
  test('--json includes a coverage disclosure (empty table)', async () => {
    const out = await captureRun(() => runSearch(engine, ['stats', '--json']));
    const stats = JSON.parse(out);
    expect(stats.coverage).toBeDefined();
    expect(stats.coverage.cli_invocations).toBe('recorded_on_clean_exit');
    // Pin the substance, not just presence — an inaccurate reason string
    // (e.g. "long-lived processes only") must fail this test. Post-#4143 the
    // contract is: clean exits flush; unclean deaths still drop.
    expect(stats.coverage.reason).toMatch(/short-lived CLI/i);
    expect(stats.coverage.reason).toMatch(/clean exit/i);
    expect(stats.coverage.reason).toMatch(/hard kill/i);
  });

  test('--json includes a coverage disclosure (non-empty table)', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'hit' } }), { results_count: 5 });
    await w.flush();

    const out = await captureRun(() => runSearch(engine, ['stats', '--json']));
    const stats = JSON.parse(out);
    expect(stats.coverage.cli_invocations).toBe('recorded_on_clean_exit');
  });

  // Wording-accuracy pin, independent of the TELEMETRY_COVERAGE_NOTE import:
  // importing the same constant into production code and the assertion
  // would let an inaccurate edit to the constant sail through unnoticed
  // (round-1 review caught exactly this class of bug — "long-lived
  // processes only" overclaimed and dropped `jobs work`). Hardcode the
  // substance here instead of comparing production output to itself.
  test('--json coverage.reason names all three long-lived process kinds + the residual-loss cases', async () => {
    const out = await captureRun(() => runSearch(engine, ['stats', '--json']));
    const reason: string = JSON.parse(out).coverage.reason;
    expect(reason).toMatch(/gbrain serve/i);
    expect(reason).toMatch(/mcp/i);
    expect(reason).toMatch(/jobs work/i);
    expect(reason).toMatch(/short-lived CLI/i);
    // Post-#4143: must not claim CLI calls are unconditionally recorded —
    // the teardown drain only covers CLEAN exits; the wording must name what
    // still drops (hard kills / over-bound drains / disconnect mid-buffer)
    // and must not assert absolutes in either direction.
    expect(reason).toMatch(/clean exit/i);
    expect(reason).toMatch(/hard kill|drops/i);
    expect(reason).not.toMatch(/\bonly\b/i);
    expect(reason).not.toMatch(/\bnever\b/i);
    expect(reason).not.toMatch(/\balways\b/i);
  });

  test('human output surfaces the exact coverage caveat (empty table)', async () => {
    const out = await captureRun(() => runSearch(engine, ['stats']));
    // Pin the literal shared constant — proves the display layer isn't
    // paraphrasing (and risking drift on) the buffering caveat.
    expect(out).toContain(TELEMETRY_COVERAGE_CAVEAT);
    expect(out.toLowerCase()).toContain('coverage gap above');
  });

  // Same independent-wording-pin rationale as the --json test above,
  // applied to the short human caveat.
  test('human coverage caveat names long-lived processes + jobs work + the residual-loss hedge, independent of the import', async () => {
    const out = await captureRun(() => runSearch(engine, ['stats']));
    expect(out).toMatch(/favors long-lived processes/i);
    expect(out).toMatch(/jobs work/i);
    expect(out).toMatch(/clean exit/i);
    expect(out).toMatch(/hard kills/i);
    expect(out).not.toMatch(/only long-lived processes/i);
  });

  test('human output surfaces the exact coverage caveat (non-empty table)', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'hit' } }), { results_count: 5 });
    await w.flush();

    const out = await captureRun(() => runSearch(engine, ['stats']));
    expect(out).toContain(TELEMETRY_COVERAGE_CAVEAT);
  });
});

describe('gbrain search tune (recommendations)', () => {
  test('insufficient data → no_recommendations status', async () => {
    const out = await captureRun(() => runSearch(engine, ['tune', '--json']));
    const r = JSON.parse(out);
    expect(r.status).toBe('insufficient_data');
    expect(r.recommendations).toEqual([]);
  });

  // Coverage disclosure: `tune`'s recommendations are only as complete as
  // the telemetry they're read from — same caveat as `search stats`.
  test('insufficient data → --json includes coverage disclosure', async () => {
    const out = await captureRun(() => runSearch(engine, ['tune', '--json']));
    const r = JSON.parse(out);
    expect(r.coverage).toBeDefined();
    expect(r.coverage.cli_invocations).toBe('recorded_on_clean_exit');
    expect(r.coverage.reason).toMatch(/short-lived CLI/i);
  });

  test('insufficient data → human output notes the exact coverage caveat', async () => {
    const out = await captureRun(() => runSearch(engine, ['tune']));
    expect(out).toContain(TELEMETRY_COVERAGE_CAVEAT);
    // The old copy told the user to "run a few `gbrain query` calls" to fix
    // a zero count — that's misleading advice given the caveat (a single
    // CLI call is exactly what tends NOT to be recorded). Pin the corrected
    // suggestion instead.
    expect(out).toMatch(/gbrain serve.*or an MCP session/i);
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
    // Coverage disclosure travels with real recommendations too, not just
    // the insufficient-data early-return path.
    expect(r.coverage.cli_invocations).toBe('recorded_on_clean_exit');
  });

  test('has_recommendations → human output notes the exact coverage caveat', async () => {
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

    const out = await captureRun(() => runSearch(engine, ['tune']));
    expect(out).toContain(TELEMETRY_COVERAGE_CAVEAT);
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
