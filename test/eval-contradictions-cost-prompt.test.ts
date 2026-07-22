/**
 * Lane C cost-prompt helper tests — hermetic via injected waitFn + stderrWriter.
 *
 * Pins the four decision branches of `maybePromptForCostBeforeProbe`:
 *   - --yes override skips
 *   - GBRAIN_NO_PROBE_PROMPT=1 env var skips
 *   - prompt_version unchanged from the last persisted run skips (no surprise)
 *   - non-TTY auto-proceeds with a stderr note (autopilot path)
 *   - TTY proceeds after the grace window
 *   - TTY aborts on Ctrl-C
 *
 * Plus reads the last prompt_version via a PGLite-backed eval_contradictions_runs
 * table to prove the cross-process state actually round-trips.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { maybePromptForCostBeforeProbe } from '../src/core/eval-contradictions/cost-prompt.ts';
import { PROMPT_VERSION } from '../src/core/eval-contradictions/types.ts';
import { writeRunRow } from '../src/core/eval-contradictions/trends.ts';
import type { ProbeReport } from '../src/core/eval-contradictions/types.ts';
import { withEnv } from './helpers/with-env.ts';

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

function captureStderr(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s: string) => { lines.push(s); } };
}

function mkBaseOpts(overrides: Partial<Parameters<typeof maybePromptForCostBeforeProbe>[0]> = {}) {
  const stderr = captureStderr();
  return {
    capture: stderr,
    opts: {
      engine,
      queryCount: 50,
      topK: 5,
      judgeModel: 'anthropic:claude-haiku-4-5',
      stderrWriter: stderr.write,
      ...overrides,
    },
  };
}

describe('maybePromptForCostBeforeProbe', () => {
  test('--yes override returns proceed without checking versions', async () => {
    const { opts, capture } = mkBaseOpts({ yesOverride: true });
    const r = await maybePromptForCostBeforeProbe(opts);
    expect(r.kind).toBe('proceed');
    if (r.kind === 'proceed') expect(r.reason).toBe('yes_override');
    expect(capture.lines.length).toBe(0);
  });

  test('GBRAIN_NO_PROBE_PROMPT=1 skips entirely', async () => {
    await withEnv({ GBRAIN_NO_PROBE_PROMPT: '1' }, async () => {
      const { opts, capture } = mkBaseOpts();
      const r = await maybePromptForCostBeforeProbe(opts);
      expect(r.kind).toBe('proceed');
      if (r.kind === 'proceed') expect(r.reason).toBe('env_skip');
      expect(capture.lines.length).toBe(0);
    });
  });

  test('prompt_version unchanged from last run → skip (no surprise)', async () => {
    // Seed a run with the CURRENT PROMPT_VERSION so the comparison returns equal.
    const report: ProbeReport = mkSeedReport(PROMPT_VERSION);
    await writeRunRow(engine, report, 100);
    const { opts, capture } = mkBaseOpts();
    const r = await maybePromptForCostBeforeProbe(opts);
    expect(r.kind).toBe('proceed');
    if (r.kind === 'proceed') expect(r.reason).toBe('no_version_change');
    expect(capture.lines.length).toBe(0);
  });

  test('non-TTY auto-proceeds with stderr note when version changed', async () => {
    // Seed a run with an OLDER prompt_version so the comparison detects change.
    const report: ProbeReport = mkSeedReport('1');
    await writeRunRow(engine, report, 100);
    const { opts, capture } = mkBaseOpts({ isTtyOverride: false });
    const r = await maybePromptForCostBeforeProbe(opts);
    expect(r.kind).toBe('proceed');
    if (r.kind === 'proceed') expect(r.reason).toBe('non_tty_auto');
    const out = capture.lines.join('');
    expect(out).toContain('PROMPT_VERSION changed');
    expect(out).toContain('Non-TTY');
  });

  test('TTY proceeds after the grace window (waitFn returns proceed)', async () => {
    const report: ProbeReport = mkSeedReport('1');
    await writeRunRow(engine, report, 100);
    let waitedSeconds = -1;
    const { opts, capture } = mkBaseOpts({
      isTtyOverride: true,
      waitFn: async (s) => { waitedSeconds = s; return 'proceed'; },
    });
    const r = await maybePromptForCostBeforeProbe(opts);
    expect(r.kind).toBe('proceed');
    if (r.kind === 'proceed') expect(r.reason).toBe('tty_proceed');
    expect(waitedSeconds).toBeGreaterThan(0);  // default 10s
    const out = capture.lines.join('');
    expect(out).toContain('Press Ctrl-C');
  });

  test('TTY aborts on Ctrl-C (waitFn returns abort)', async () => {
    const report: ProbeReport = mkSeedReport('1');
    await writeRunRow(engine, report, 100);
    const { opts, capture } = mkBaseOpts({
      isTtyOverride: true,
      waitFn: async () => 'abort',
    });
    const r = await maybePromptForCostBeforeProbe(opts);
    expect(r.kind).toBe('abort');
    if (r.kind === 'abort') expect(r.reason).toBe('tty_ctrl_c');
    const out = capture.lines.join('');
    expect(out).toContain('aborted by Ctrl-C');
  });

  test('fresh brain (no prior runs) fires the prompt on first run', async () => {
    // No seed — readLastPromptVersion returns null.
    const { opts, capture } = mkBaseOpts({
      isTtyOverride: true,
      waitFn: async () => 'proceed',
    });
    const r = await maybePromptForCostBeforeProbe(opts);
    expect(r.kind).toBe('proceed');
    if (r.kind === 'proceed') expect(r.reason).toBe('tty_proceed');
    const out = capture.lines.join('');
    expect(out).toContain('PROMPT_VERSION changed (none →');
  });

  test('GBRAIN_PROBE_PROMPT_GRACE_SECONDS env overrides the 10s default', async () => {
    await withEnv({ GBRAIN_PROBE_PROMPT_GRACE_SECONDS: '0' }, async () => {
      let waitedSeconds = -1;
      const report: ProbeReport = mkSeedReport('1');
      await writeRunRow(engine, report, 100);
      const { opts } = mkBaseOpts({
        isTtyOverride: true,
        waitFn: async (s) => { waitedSeconds = s; return 'proceed'; },
      });
      await maybePromptForCostBeforeProbe(opts);
      expect(waitedSeconds).toBe(0);
    });
  });

  test('estimate scales with query count + judge model in the banner text', async () => {
    const report: ProbeReport = mkSeedReport('1');
    await writeRunRow(engine, report, 100);
    const { opts, capture } = mkBaseOpts({
      isTtyOverride: false,
      queryCount: 500,
      judgeModel: 'anthropic:claude-sonnet-4-6',
    });
    await maybePromptForCostBeforeProbe(opts);
    const out = capture.lines.join('');
    expect(out).toContain('500 queries');
    expect(out).toContain('anthropic:claude-sonnet-4-6');
    expect(out).toMatch(/\$\d+\.\d{2}/);
  });
});

function mkSeedReport(promptVersion: string): ProbeReport {
  return {
    schema_version: 1,
    run_id: `seed-${promptVersion}`,
    judge_model: 'anthropic:claude-haiku-4-5',
    prompt_version: promptVersion,
    truncation_policy: '1500-chars-utf8-safe',
    top_k: 5,
    sampling: 'deterministic',
    queries_evaluated: 50,
    queries_with_contradiction: 12,
    queries_with_any_finding: 12,
    total_contradictions_flagged: 12,
    verdict_breakdown: {
      no_contradiction: 100,
      contradiction: 12,
      temporal_supersession: 0,
      temporal_regression: 0,
      temporal_evolution: 0,
      negation_artifact: 0,
    },
    calibration: {
      queries_total: 50,
      queries_judged_clean: 38,
      queries_with_contradiction: 12,
      wilson_ci_95: { point: 0.24, lower: 0.14, upper: 0.37 },
    },
    judge_errors: { parse_fail: 0, refusal: 0, timeout: 0, http_5xx: 0, unknown: 0, total: 0, note: '' },
    cost_usd: { judge: 1.0, embedding: 0.005, total: 1.005, estimate_note: '' },
    cache: { hits: 0, misses: 0, hit_rate: 0 },
    duration_ms: 45000,
    source_tier_breakdown: { curated_vs_curated: 0, curated_vs_bulk: 0, bulk_vs_bulk: 0, other: 0 },
    per_query: [],
    hot_pages: [],
  };
}
