/**
 * v0.40.1.0 Track D / T6+T7 — Nightly quality probe phase + doctor check.
 *
 * Hermetic: every external effect goes through the NightlyProbeDeps DI
 * surface. No PGLite, no real LLM calls, no env mutation outside withEnv.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  runNightlyQualityProbe,
  shouldRunNightly,
  type NightlyProbeDeps,
  type NightlyProbeResult,
} from '../src/core/cycle/nightly-quality-probe.ts';
import type { CrossModalBatchSummary } from '../src/core/cycle/nightly-probe-adapters.ts';
import type { QualityProbeFailure } from '../src/core/audit-quality-probe.ts';
import { estimateChatCostUsd, recordChatUsage } from '../src/core/ai/chat-usage.ts';
import { DEFAULT_SLOTS } from '../src/core/cross-modal-eval/runner.ts';
import { withEnv } from './helpers/with-env.ts';

// ---------------------------------------------------------------------------
// Hermetic audit dir per test
// ---------------------------------------------------------------------------

let auditTmp: string;

beforeEach(() => {
  auditTmp = mkdtempSync(join(tmpdir(), 'qprobe-audit-'));
});

afterEach(() => {
  try { rmSync(auditTmp, { recursive: true, force: true }); } catch { /* best */ }
});

// ---------------------------------------------------------------------------
// 1. shouldRunNightly pure function
// ---------------------------------------------------------------------------

describe('shouldRunNightly (pure function, rate-limit logic)', () => {
  test('empty history → run', () => {
    expect(shouldRunNightly(new Date('2026-05-22T00:00:00Z'), [])).toEqual({ run: true });
  });

  test('last event > 24h ago → run', () => {
    const r = shouldRunNightly(
      new Date('2026-05-22T00:00:00Z'),
      [{ ts: '2026-05-20T00:00:00Z' }],
    );
    expect(r).toEqual({ run: true });
  });

  test('last event within 24h → rate-limited', () => {
    const r = shouldRunNightly(
      new Date('2026-05-22T00:00:00Z'),
      [{ ts: '2026-05-21T12:00:00Z' }],
    );
    expect(r).toEqual({ run: false, reason: 'rate_limited' });
  });

  test('one event old, one event recent → rate-limited (any recent fires it)', () => {
    const r = shouldRunNightly(
      new Date('2026-05-22T00:00:00Z'),
      [
        { ts: '2026-05-01T00:00:00Z' },
        { ts: '2026-05-21T20:00:00Z' },
      ],
    );
    expect(r).toEqual({ run: false, reason: 'rate_limited' });
  });

  test('corrupt timestamp → ignored (does not rate-limit)', () => {
    const r = shouldRunNightly(
      new Date('2026-05-22T00:00:00Z'),
      [{ ts: 'not a date' }],
    );
    expect(r).toEqual({ run: true });
  });

  test('configurable window respected', () => {
    // 1-hour window: 6h ago counts as old.
    const r = shouldRunNightly(
      new Date('2026-05-22T00:00:00Z'),
      [{ ts: '2026-05-21T18:00:00Z' }],
      60 * 60 * 1000,
    );
    expect(r).toEqual({ run: true });
  });
});

// ---------------------------------------------------------------------------
// 2. runNightlyQualityProbe via DI stubs
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<NightlyProbeDeps> = {}): NightlyProbeDeps {
  return {
    isEnabled: async () => true,
    hasEmbeddingProvider: async () => true,
    resolveMaxUsd: async () => 5,
    resolveRepoRoot: async () => process.cwd(),
    runLongMemEval: async () => { /* stub */ },
    runCrossModalBatch: async () => ({
      exitCode: 0,
      summary: {
        pass_count: 5, fail_count: 0, inconclusive_count: 0, error_count: 0,
        est_cost_usd: 0.35, verdict: 'pass',
      },
    }),
    now: () => new Date(),
    ...overrides,
  };
}

describe('runNightlyQualityProbe (DI stub harness)', () => {
  test('disabled config → outcome: disabled, no audit row', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps({ isEnabled: async () => false }));
      expect(r.outcome).toBe('disabled');
      expect(r.exit_code).toBe(0);
      // No audit row written.
      const events = await readEvents();
      expect(events.length).toBe(0);
    });
  });

  test('enabled + no embedding key → outcome: no_embedding_key with audit row', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps({ hasEmbeddingProvider: async () => false }));
      expect(r.outcome).toBe('no_embedding_key');
      const events = await readEvents();
      expect(events.length).toBe(1);
      expect(events[0].outcome).toBe('no_embedding_key');
    });
  });

  test('enabled + recent run within 24h → outcome: rate_limited, NO audit row', async () => {
    // Pre-seed a recent audit event by running the probe once first.
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      // First run succeeds.
      await runNightlyQualityProbe(makeDeps());
      // Second run, same hour → rate_limited. A skip is a non-event: the
      // autopilot loop invokes the probe every cycle (~5-10 min), so
      // logging each skip would flood the audit file and flip doctor's
      // any-non-pass-is-bad filter to a permanent WARN.
      const r2 = await runNightlyQualityProbe(makeDeps());
      expect(r2.outcome).toBe('rate_limited');
      const events = await readEvents();
      expect(events.length).toBe(1);
      expect(events[0].outcome).toBe('pass');
    });
  });

  test('enabled + PASS summary → outcome: pass with audit row', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps());
      expect(r.outcome).toBe('pass');
      expect(r.exit_code).toBe(0);
      const events = await readEvents();
      expect(events.length).toBe(1);
      expect(events[0].outcome).toBe('pass');
      expect(events[0].pass_count).toBe(5);
      expect(events[0].est_cost_usd).toBe(0.35);
    });
  });

  test('threads live search-mode/reranker snapshot into LongMemEval', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      let seenSnapshot: Record<string, string> | undefined;
      const r = await runNightlyQualityProbe(makeDeps({
        resolveSearchConfigSnapshot: async () => ({
          'search.mode': 'balanced',
          'search.reranker.enabled': 'true',
          'search.reranker.model': 'llama-server-reranker:qwen3-reranker-4b',
          'search.reranker.timeout_ms': '30000',
        }),
        runLongMemEval: async (args) => {
          seenSnapshot = args.searchConfigSnapshot;
        },
      }));

      expect(r.outcome).toBe('pass');
      expect(seenSnapshot).toEqual({
        'search.mode': 'balanced',
        'search.reranker.enabled': 'true',
        'search.reranker.model': 'llama-server-reranker:qwen3-reranker-4b',
        'search.reranker.timeout_ms': '30000',
      });
    });
  });

  test('enabled + FAIL summary → outcome: fail', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps({
        runCrossModalBatch: async () => ({
          exitCode: 1,
          summary: {
            pass_count: 7, fail_count: 3, inconclusive_count: 0, error_count: 0,
            est_cost_usd: 0.42, verdict: 'fail',
          },
        }),
      }));
      expect(r.outcome).toBe('fail');
      expect(r.exit_code).toBe(1);
      const events = await readEvents();
      expect(events[0].outcome).toBe('fail');
      expect(events[0].fail_count).toBe(3);
    });
  });

  test('threads the brain-resolved model routes into both adapters (#5872)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const routes = {
        reader: { model: 'claude-cli:claude-opus-5-5', source: 'tier_config' as const },
        extractor: { model: 'claude-cli:claude-sonnet-5', source: 'tier_config' as const },
        slots: { B: 'claude-cli:claude-fable-5' },
      };
      const seen: { lme?: unknown; crossModal?: unknown } = {};
      const r = await runNightlyQualityProbe(makeDeps({
        resolveModelRoutes: async () => routes,
        runLongMemEval: async (args) => { seen.lme = args.modelRoutes; },
        runCrossModalBatch: async (args) => {
          seen.crossModal = args.modelRoutes;
          return {
            exitCode: 0,
            summary: { pass_count: 5, fail_count: 0, inconclusive_count: 0, error_count: 0, est_cost_usd: 0.35, verdict: 'pass' },
          };
        },
      }));
      expect(r.outcome).toBe('pass');
      expect(seen.lme).toEqual(routes);
      expect(seen.crossModal).toEqual(routes);
    });
  });

  test('resolveModelRoutes throws → error audit row naming the routes, LongMemEval never starts (#5872)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      let longMemEvalCalls = 0;
      const r = await runNightlyQualityProbe(makeDeps({
        resolveModelRoutes: async () => { throw new Error('gateway refresh failed'); },
        runLongMemEval: async () => { longMemEvalCalls++; },
      }));
      expect(r.outcome).toBe('error');
      expect(longMemEvalCalls).toBe(0);
      const events = await readEvents();
      expect(events).toHaveLength(1);
      expect(events[0].outcome).toBe('error');
      expect(events[0].detail).toBe(
        'nightly-quality-probe: could not resolve the model routes (reader, extractor, judge slots) ' +
        'from the brain: gateway refresh failed',
      );
      // No route resolved and no model call ran (#5506).
      expect(events[0].reader_model).toBeUndefined();
      expect(events[0].chat_calls).toBeUndefined();
    });
  });

  test('runLongMemEval throws → outcome: error with audit row', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps({
        runLongMemEval: async () => { throw new Error('longmemeval blew up'); },
      }));
      expect(r.outcome).toBe('error');
      expect(r.exit_code).toBe(1);
      const events = await readEvents();
      expect(events[0].outcome).toBe('error');
      expect(events[0].detail).toContain('longmemeval blew up');
    });
  });

  test('missing fixture → outcome: skipped with reason fixture_unavailable, no model call (#5187)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      let longMemEvalCalls = 0;
      const r = await runNightlyQualityProbe(makeDeps({
        resolveRepoRoot: async () => '/this/repo/root/does/not/exist',
        runLongMemEval: async () => { longMemEvalCalls++; },
      }));
      expect(r.outcome).toBe('skipped');
      expect(r.exit_code).toBe(0);
      expect(longMemEvalCalls).toBe(0);
      const events = await readEvents();
      expect(events[0].outcome).toBe('skipped');
      expect(events[0].reason).toBe('fixture_unavailable');
      expect(events[0].detail).toContain('the nightly fixture is not readable at /this/repo/root/does/not/exist/test/fixtures/longmemeval-nightly.jsonl');
      expect(events[0].detail).toContain('gbrain doctor');
    });
  });

  test('resolveFixturePath wins over resolveRepoRoot (the embedded fixture, #5187)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const { NIGHTLY_PROBE_FIXTURES } = await import('../src/core/cycle/nightly-probe-fixtures.ts');
      let seen = '';
      const r = await runNightlyQualityProbe(makeDeps({
        resolveRepoRoot: async () => '/this/repo/root/does/not/exist',
        resolveFixturePath: () => NIGHTLY_PROBE_FIXTURES.longMemEval,
        runLongMemEval: async (args) => { seen = args.fixturePath; },
      }));
      expect(r.outcome).toBe('pass');
      expect(seen).toBe(NIGHTLY_PROBE_FIXTURES.longMemEval);
      expect(readFileSync(seen, 'utf8').trim().split('\n')).toHaveLength(10);
    });
  });

  test('audit event records fixture_sha8 on successful runs', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps());
      expect(r.outcome).toBe('pass');
      const events = await readEvents();
      expect(events[0].fixture_sha8).toMatch(/^[0-9a-f]{8}$/);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readEvents(): Promise<any[]> {
  // Re-import so it uses the override env var picked up at call time.
  const { readRecentQualityProbeEvents } = await import('../src/core/audit-quality-probe.ts');
  return readRecentQualityProbeEvents(2);
}

// ---------------------------------------------------------------------------
// 3. computeNightlyQualityProbeHealthCheck pure function (doctor.ts coverage)
// ---------------------------------------------------------------------------

describe('computeNightlyQualityProbeHealthCheck — pure doctor branch coverage', () => {
  test('disabled + no events → ok with paste-ready enable hint', async () => {
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const check = computeNightlyQualityProbeHealthCheck(false, []);
    expect(check.name).toBe('nightly_quality_probe_health');
    expect(check.status).toBe('ok');
    expect(check.message).toMatch(/disabled \(opt-in\)/);
    expect(check.message).toMatch(/gbrain config set autopilot\.nightly_quality_probe\.enabled true/);
  });

  test('latest run skipped (fixture unavailable) → warn with skipped count and reason, never ok (#5187)', async () => {
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const check = computeNightlyQualityProbeHealthCheck(true, [
      { outcome: 'skipped', ts: '2026-10-02T03:00:00Z', detail: 'the nightly fixture is not readable at /x.jsonl' },
    ]);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('skipped=1');
    expect(check.message).toContain('Latest: skipped at 2026-10-02T03:00:00Z (the nightly fixture is not readable at /x.jsonl)');
  });

  test('enabled + no events → ok pending', async () => {
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const check = computeNightlyQualityProbeHealthCheck(true, []);
    expect(check.status).toBe('ok');
    expect(check.message).toMatch(/enabled but no probe events/);
  });

  test('enabled + all-PASS events → ok with latest timestamp', async () => {
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const events = [
      { outcome: 'pass', ts: '2026-05-20T03:00:00Z' },
      { outcome: 'pass', ts: '2026-05-21T03:00:00Z' },
      { outcome: 'pass', ts: '2026-05-22T03:00:00Z' },
    ];
    const check = computeNightlyQualityProbeHealthCheck(true, events);
    expect(check.status).toBe('ok');
    expect(check.message).toMatch(/3 PASS runs/);
    expect(check.message).toContain('2026-05-22T03:00:00Z');
  });

  test('enabled + ANY fail/error/budget_exceeded → warn with per-outcome counts', async () => {
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const events = [
      { outcome: 'pass', ts: '2026-05-19T03:00:00Z' },
      { outcome: 'fail', ts: '2026-05-20T03:00:00Z' },
      { outcome: 'error', ts: '2026-05-21T03:00:00Z', detail: 'longmemeval blew up' },
      { outcome: 'budget_exceeded', ts: '2026-05-22T03:00:00Z' },
    ];
    const check = computeNightlyQualityProbeHealthCheck(true, events);
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/3 non-PASS runs/);
    expect(check.message).toMatch(/pass=1/);
    expect(check.message).toMatch(/fail=1/);
    expect(check.message).toMatch(/error=1/);
    expect(check.message).toMatch(/budget=1/);
    // Latest in the list is what surfaces in the message.
    expect(check.message).toContain('budget_exceeded');
    expect(check.message).toContain('2026-05-22T03:00:00Z');
  });

  test('latest event with detail → detail surfaces in warn message', async () => {
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const events = [
      { outcome: 'error', ts: '2026-05-22T03:00:00Z', detail: 'no embedding provider' },
    ];
    const check = computeNightlyQualityProbeHealthCheck(true, events);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('no embedding provider');
  });

  test('single non-PASS event uses singular grammar', async () => {
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const events = [{ outcome: 'fail', ts: '2026-05-22T03:00:00Z' }];
    const check = computeNightlyQualityProbeHealthCheck(true, events);
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/1 non-PASS run /); // "run " not "runs "
  });

  test('cross-week ordering: reader sorts chronologically so "Latest" is the newest run', async () => {
    // Regression: the reader walks the CURRENT week's file first, then the
    // previous week's. Without sorting, the array tail — which this check
    // reports as "Latest:" — was the OLDEST in-window event whenever last
    // week's file had entries (observed live: counts updated as new runs
    // landed while "Latest" stayed pinned days behind).
    const { computeQualityProbeAuditFilename, readRecentQualityProbeEvents } =
      await import('../src/core/audit-quality-probe.ts');
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const now = new Date('2026-07-23T12:00:00Z');
    const thisWeekFile = computeQualityProbeAuditFilename(now);
    const prevWeekFile = computeQualityProbeAuditFilename(new Date(now.getTime() - 7 * 86400000));
    writeFileSync(join(auditTmp, thisWeekFile), [
      JSON.stringify({ outcome: 'fail', ts: '2026-07-22T08:00:00Z' }),
      JSON.stringify({ outcome: 'fail', ts: '2026-07-23T08:00:00Z' }),
    ].join('\n') + '\n');
    writeFileSync(join(auditTmp, prevWeekFile), [
      JSON.stringify({ outcome: 'fail', ts: '2026-07-17T08:00:00Z' }),
      JSON.stringify({ outcome: 'fail', ts: '2026-07-18T08:00:00Z' }),
    ].join('\n') + '\n');
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const events = readRecentQualityProbeEvents(7, now);
      expect(events.map(e => e.ts)).toEqual([
        '2026-07-17T08:00:00Z',
        '2026-07-18T08:00:00Z',
        '2026-07-22T08:00:00Z',
        '2026-07-23T08:00:00Z',
      ]);
      const check = computeNightlyQualityProbeHealthCheck(true, events);
      expect(check.message).toContain('Latest: fail at 2026-07-23T08:00:00Z');
    });
  });

  test('single PASS event uses singular grammar', async () => {
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const events = [{ outcome: 'pass', ts: '2026-05-22T03:00:00Z' }];
    const check = computeNightlyQualityProbeHealthCheck(true, events);
    expect(check.status).toBe('ok');
    expect(check.message).toMatch(/1 PASS run /); // "run " not "runs "
  });
});

// ---------------------------------------------------------------------------
// 4. Codex CDX-5 — doctor flags ALL non-PASS outcomes (no_embedding_key,
// rate_limited, inconclusive must trip warn, not get silently reported as PASS)
// ---------------------------------------------------------------------------

describe('codex CDX-5 — doctor health: every non-PASS outcome surfaces', () => {
  test('no_embedding_key outcome → warn (was silently PASS before CDX-5 fix)', async () => {
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const events = [{ outcome: 'no_embedding_key', ts: '2026-05-22T03:00:00Z' }];
    const check = computeNightlyQualityProbeHealthCheck(true, events);
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/no_embed_key=1/);
  });

  test('rate_limited outcome → warn', async () => {
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const events = [{ outcome: 'rate_limited', ts: '2026-05-22T03:00:00Z' }];
    const check = computeNightlyQualityProbeHealthCheck(true, events);
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/rate_limited=1/);
  });

  test('inconclusive outcome → warn', async () => {
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const events = [{ outcome: 'inconclusive', ts: '2026-05-22T03:00:00Z' }];
    const check = computeNightlyQualityProbeHealthCheck(true, events);
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/inconclusive=1/);
  });

  test('counts include the new outcome buckets when mixed with pass/fail/error', async () => {
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const events = [
      { outcome: 'pass', ts: '2026-05-16T03:00:00Z' },
      { outcome: 'fail', ts: '2026-05-17T03:00:00Z' },
      { outcome: 'error', ts: '2026-05-18T03:00:00Z' },
      { outcome: 'inconclusive', ts: '2026-05-19T03:00:00Z' },
      { outcome: 'budget_exceeded', ts: '2026-05-20T03:00:00Z' },
      { outcome: 'no_embedding_key', ts: '2026-05-21T03:00:00Z' },
      { outcome: 'rate_limited', ts: '2026-05-22T03:00:00Z' },
    ];
    const check = computeNightlyQualityProbeHealthCheck(true, events);
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/6 non-PASS runs/); // 7 total, 1 pass, 6 bad
    expect(check.message).toMatch(/pass=1/);
    expect(check.message).toMatch(/fail=1/);
    expect(check.message).toMatch(/error=1/);
    expect(check.message).toMatch(/inconclusive=1/);
    expect(check.message).toMatch(/budget=1/);
    expect(check.message).toMatch(/no_embed_key=1/);
    expect(check.message).toMatch(/rate_limited=1/);
  });
});

// ---------------------------------------------------------------------------
// 5. #5506: the audit row carries the evidence behind its verdict
// ---------------------------------------------------------------------------

const SONNET = 'anthropic:claude-sonnet-4-6';
const OPUS = 'anthropic:claude-opus-4-7';
const COLLAPSED_PANEL = { judge_models: [SONNET, OPUS, SONNET], panel: { distinct_models: 2, distinct_providers: 1 } };
const CLI_PANEL = {
  judge_models: ['claude-cli:claude-opus-5-5', 'claude-cli:claude-sonnet-5', 'claude-cli:claude-haiku-4-5-20251001'],
  panel: { distinct_models: 3, distinct_providers: 1 },
};
const ROUTES = {
  reader: { model: 'claude-cli:claude-opus-5-5', source: 'tier_config' as const },
  extractor: { model: 'claude-cli:claude-sonnet-5', source: 'tier_config' as const },
  slots: {},
};

function directnessFailure(questionId: string, scores: number[]): QualityProbeFailure {
  const mean = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
  return {
    question_id: questionId,
    verdict: 'fail',
    dimensions: [{ dimension: 'directness', mean, scores, fail_reason: 'mean_below_7' }],
  };
}

function batchStub(summary: CrossModalBatchSummary, exitCode = 1): NightlyProbeDeps['runCrossModalBatch'] {
  return async () => ({ exitCode, summary });
}

describe('runNightlyQualityProbe: panel, failures and digest on the audit row (#5506)', () => {
  test('a FAIL summary on a sound panel writes the judge panel, each failing question and a digest detail', async () => {
    const failures = [[6, 7, 6], [5, 8, 6], [5, 8, 5], [6, 7, 5], [6, 8, 6], [5, 7, 6]]
      .map((scores, i) => directnessFailure(`q${i + 1}`, scores));
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps({
        runCrossModalBatch: batchStub({
          pass_count: 4, fail_count: 6, inconclusive_count: 0, error_count: 0, est_cost_usd: 2.8,
          verdict: 'fail', total: 10, failures, ...CLI_PANEL,
        }),
      }));
      expect(r.outcome).toBe('fail');
      const [event] = await readEvents();
      expect(event.judge_models).toEqual(CLI_PANEL.judge_models);
      expect(event.distinct_judge_models).toBe(3);
      expect(event.distinct_judge_providers).toBe(1);
      expect(event.failures).toEqual(failures);
      expect(event.reason).toBeUndefined();
      expect(event.detail).toBe(
        '6/10 questions did not pass (directness mean_below_7 x6); judges: 3 distinct models from 1 provider',
      );
      expect(event.est_cost_usd).toBe(2.8);
    });
  });

  test('a sonnet/opus/sonnet panel turns a FAIL into inconclusive with the remedy (#5506, D12)', async () => {
    const failures = [[6, 7, 6], [5, 8, 6]].map((scores, i) => directnessFailure(`q${i + 1}`, scores));
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps({
        runCrossModalBatch: batchStub({
          pass_count: 8, fail_count: 2, inconclusive_count: 0, error_count: 0, est_cost_usd: 2.8,
          verdict: 'fail', total: 10, failures, ...COLLAPSED_PANEL,
        }),
      }));
      expect(r.outcome).toBe('inconclusive');
      const [event] = await readEvents();
      expect(event.outcome).toBe('inconclusive');
      expect(event.reason).toBe('panel_collapsed');
      expect(event.judge_models).toEqual([SONNET, OPUS, SONNET]);
      expect(event.failures).toEqual(failures);
      expect(event.detail).toBe(
        `judge panel collapsed: ${SONNET} holds slots A, C, so its votes count more than once. ` +
        'Set three different judge models: gbrain config set models.eval.cross_modal.slot_a <model> ' +
        '(and slot_b, slot_c; one provider is enough). ' +
        'See docs/eval-bench.md#nightly-cross-modal-quality-probe-opt-in-autopilot (batch verdict: fail); ' +
        '2/10 questions did not pass (directness mean_below_7 x2); judges: 2 distinct models from 1 provider',
      );
    });
  });

  test('a PASS from a collapsed panel is inconclusive, never a pass', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps({
        runCrossModalBatch: batchStub({
          pass_count: 10, fail_count: 0, inconclusive_count: 0, error_count: 0, est_cost_usd: 1.8,
          verdict: 'pass', total: 10, ...COLLAPSED_PANEL,
        }, 0),
      }));
      expect(r.outcome).toBe('inconclusive');
      const [event] = await readEvents();
      expect(event.outcome).toBe('inconclusive');
      expect(event.reason).toBe('panel_collapsed');
      expect(event.judge_models).toEqual([SONNET, OPUS, SONNET]);
      expect(event.failures).toBeUndefined();
      expect(event.detail).toStartWith(`judge panel collapsed: ${SONNET} holds slots A, C`);
    });
  });

  test('only one model judged (two slots silent) is inconclusive', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps({
        runCrossModalBatch: batchStub({
          pass_count: 10, fail_count: 0, inconclusive_count: 0, error_count: 0, est_cost_usd: 1.8,
          verdict: 'pass', total: 10, judge_models: CLI_PANEL.judge_models,
          panel: { distinct_models: 1, distinct_providers: 1, slot_scored_questions: [10, 0, 0] },
        }, 0),
      }));
      expect(r.outcome).toBe('inconclusive');
      const [event] = await readEvents();
      expect(event.reason).toBe('panel_collapsed');
      expect(event.detail).toStartWith('judge panel collapsed: 1 distinct model judged, so there is no cross-check.');
    });
  });

  test('a PASS summary on a sound panel records the panel and no failure list or digest', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      await runNightlyQualityProbe(makeDeps({
        runCrossModalBatch: batchStub({
          pass_count: 10, fail_count: 0, inconclusive_count: 0, error_count: 0, est_cost_usd: 1.8,
          verdict: 'pass', total: 10, ...CLI_PANEL,
        }, 0),
      }));
      const [event] = await readEvents();
      expect(event.outcome).toBe('pass');
      expect(event.judge_models).toEqual(CLI_PANEL.judge_models);
      expect(event.failures).toBeUndefined();
      expect(event.detail).toBeUndefined();
      expect(event.receipt_dir).toBeUndefined();
    });
  });

  test('more than 10 non-passing questions: the row lists the first 10, the digest counts all', async () => {
    const failures: QualityProbeFailure[] = [
      ...Array.from({ length: 11 }, (_, i) => directnessFailure(`q${i + 1}`, [6, 6, 6])),
      { question_id: 'q12', verdict: 'upstream_error', error: 'reader produced no hypothesis' },
    ];
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      await runNightlyQualityProbe(makeDeps({
        runCrossModalBatch: batchStub({
          pass_count: 0, fail_count: 11, inconclusive_count: 0, error_count: 0, est_cost_usd: 2.8,
          verdict: 'error', total: 12, failures, judge_models: DEFAULT_SLOTS.map(s => s.model),
          panel: { distinct_models: 3, distinct_providers: 3 },
        }, 2),
      }));
      const [event] = await readEvents();
      expect(event.outcome).toBe('error');
      expect(event.failures).toEqual(failures.slice(0, 10));
      expect(event.detail).toBe(
        '12/12 questions did not pass (directness mean_below_7 x11, upstream_error x1); ' +
        'judges: 3 distinct models from 3 providers',
      );
    });
  });

  const SIX_FAILURES = [[6, 7, 6], [5, 8, 6], [5, 8, 5], [6, 7, 5], [6, 8, 6], [5, 7, 6]]
    .map((scores, i) => directnessFailure(`q${i + 1}`, scores));
  const DIGEST_CASES = [
    {
      // A malformed row has no failure entry but counts in the total.
      name: 'malformed rows count as not passing',
      summary: {
        verdict: 'error', total: 10, malformed_count: 1, pass_count: 3, fail_count: 6, failures: SIX_FAILURES,
        ...COLLAPSED_PANEL,
      },
      detail: '7/10 questions did not pass (directness mean_below_7 x6, malformed x1); ' +
        'judges: 2 distinct models from 1 provider',
      failures: SIX_FAILURES,
      judgeScoredQuestions: undefined,
    },
    {
      name: 'a batch of malformed rows only still gets a digest',
      summary: { verdict: 'error', total: 10, malformed_count: 2, pass_count: 8, fail_count: 0, ...COLLAPSED_PANEL },
      detail: '2/10 questions did not pass (malformed x2); judges: 2 distinct models from 1 provider',
      failures: undefined,
      judgeScoredQuestions: undefined,
    },
    {
      name: 'a slot that scored no question is named',
      summary: {
        verdict: 'fail', total: 10, pass_count: 4, fail_count: 6, failures: SIX_FAILURES,
        judge_models: DEFAULT_SLOTS.map(s => s.model),
        panel: { distinct_models: 2, distinct_providers: 2, slot_scored_questions: [10, 0, 10] },
      },
      detail: '6/10 questions did not pass (directness mean_below_7 x6); ' +
        `judges: 2 distinct models from 2 providers, slot B (${DEFAULT_SLOTS[1]!.model}) scored no question`,
      failures: SIX_FAILURES,
      judgeScoredQuestions: [10, 0, 10],
    },
  ];

  test.each(DIGEST_CASES)('digest: $name', async ({ summary, detail, failures, judgeScoredQuestions }) => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      await runNightlyQualityProbe(makeDeps({
        runCrossModalBatch: batchStub({ inconclusive_count: 0, error_count: 0, est_cost_usd: 2.8, ...summary }, 2),
      }));
      const [event] = await readEvents();
      expect(event.detail).toBe(detail);
      expect(event.failures).toEqual(failures);
      expect(event.judge_scored_questions).toEqual(judgeScoredQuestions);
    });
  });

  test('rows written after the routes resolved name the reader and extractor', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      await runNightlyQualityProbe(makeDeps({ resolveModelRoutes: async () => ROUTES }));
      const after = new Date(Date.now() + 25 * 60 * 60 * 1000);
      await runNightlyQualityProbe(makeDeps({
        now: () => after,
        resolveModelRoutes: async () => ROUTES,
        runLongMemEval: async () => { throw new Error('longmemeval blew up'); },
      }));
      const { readRecentQualityProbeEvents } = await import('../src/core/audit-quality-probe.ts');
      const events = readRecentQualityProbeEvents(2, after);
      expect(events.map(e => [e.outcome, e.reader_model, e.extractor_model])).toEqual([
        ['pass', 'claude-cli:claude-opus-5-5', 'claude-cli:claude-sonnet-5'],
        ['error', 'claude-cli:claude-opus-5-5', 'claude-cli:claude-sonnet-5'],
      ]);
    });
  });
});

describe('runNightlyQualityProbe: metered chat spend (#5506)', () => {
  const usage = { input_tokens: 1000, output_tokens: 500 };
  const PRICED = 'anthropic:claude-haiku-4-5';
  const UNPRICED = 'acme:unpriced-model-9000';
  const pricedCost = () => estimateChatCostUsd(PRICED, usage)!;

  test('calls in both stages are metered: priced cost summed, unpriced counted apart', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      await runNightlyQualityProbe(makeDeps({
        runLongMemEval: async () => {
          recordChatUsage({ model: PRICED, usage });
          await Promise.resolve();
          recordChatUsage({ model: UNPRICED, usage });
        },
        runCrossModalBatch: async () => {
          await Promise.resolve();
          recordChatUsage({ model: PRICED, usage });
          return {
            exitCode: 0,
            summary: { pass_count: 10, fail_count: 0, inconclusive_count: 0, error_count: 0, est_cost_usd: 2.8, verdict: 'pass' },
          };
        },
      }));
      const [event] = await readEvents();
      expect(event.chat_calls).toBe(3);
      expect(event.chat_cost_usd).toBeCloseTo(2 * pricedCost(), 6);
      expect(event.unpriced_chat_calls).toBe(1);
      expect(event.est_cost_usd).toBe(2.8);
    });
  });

  test('a run whose every call is unpriced records 0 cost and every call as unpriced', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      await runNightlyQualityProbe(makeDeps({
        runLongMemEval: async () => {
          recordChatUsage({ model: UNPRICED, usage });
          recordChatUsage({ model: UNPRICED, usage });
        },
      }));
      const [event] = await readEvents();
      expect([event.chat_calls, event.chat_cost_usd, event.unpriced_chat_calls]).toEqual([2, 0, 2]);
    });
  });

  test('a run that fails part-way records the spend metered up to the failure', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps({
        runLongMemEval: async () => {
          recordChatUsage({ model: PRICED, usage });
          throw new Error('longmemeval blew up');
        },
      }));
      expect(r.outcome).toBe('error');
      const [event] = await readEvents();
      expect(event.detail).toContain('longmemeval blew up');
      expect(event.chat_calls).toBe(1);
      expect(event.chat_cost_usd).toBeCloseTo(pricedCost(), 6);
      expect(event.unpriced_chat_calls).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. #5506: doctor names the latest run's judge panel
// ---------------------------------------------------------------------------

describe('computeNightlyQualityProbeHealthCheck: judge panel (#5506)', () => {
  const TS = '2026-10-02T11:14:26Z';
  const OK = `1 PASS run in last 7d. Latest: ${TS}.`;
  const WARN =
    '1 non-PASS run in last 7d (pass=0 fail=1 error=0 inconclusive=0 budget=0 no_embed_key=0 rate_limited=0). ' +
    `Latest: fail at ${TS}.`;
  const CLI_MODELS = ['claude-cli:claude-opus-5-5', 'claude-cli:claude-sonnet-5', 'claude-cli:claude-haiku-4-5-20251001'];
  const DUPLICATE_NOTE =
    ` ${SONNET} holds more than one slot, so its votes count more than once. ` +
    'Next step: set models.eval.cross_modal.slot_a, slot_b and slot_c to three different models ' +
    '(gbrain config set models.eval.cross_modal.slot_a <model>; one provider is enough, for example three claude-cli models).';
  const NOT_CROSS_MODAL = ' Fewer than 3 providers judged, so the panel is not cross-modal (information only).';
  const PANELS = {
    collapsed: {
      fields: { judge_models: [SONNET, OPUS, SONNET], distinct_judge_models: 2, distinct_judge_providers: 1 },
      note: ` Latest judge panel (slot order): ${SONNET}, ${OPUS}, ${SONNET}; 2 distinct models from 1 provider.` + DUPLICATE_NOTE,
    },
    oneProvider: {
      fields: { judge_models: CLI_MODELS, distinct_judge_models: 3, distinct_judge_providers: 1 },
      note: ` Latest judge panel (slot order): ${CLI_MODELS.join(', ')}; 3 distinct models from 1 provider.` + NOT_CROSS_MODAL,
    },
    twoProviders: {
      fields: { judge_models: [CLI_MODELS[0]!, SONNET, OPUS], distinct_judge_models: 3, distinct_judge_providers: 2 },
      note: ` Latest judge panel (slot order): ${CLI_MODELS[0]}, ${SONNET}, ${OPUS}; 3 distinct models from 2 providers.` +
        NOT_CROSS_MODAL,
    },
    threeProviders: {
      fields: { judge_models: DEFAULT_SLOTS.map(s => s.model), distinct_judge_models: 3, distinct_judge_providers: 3 },
      note: ` Latest judge panel (slot order): ${DEFAULT_SLOTS.map(s => s.model).join(', ')}; 3 distinct models from 3 providers.`,
    },
    silentSlot: {
      fields: {
        judge_models: DEFAULT_SLOTS.map(s => s.model), judge_scored_questions: [10, 0, 10],
        distinct_judge_models: 2, distinct_judge_providers: 2,
      },
      note: ` Latest judge panel (slot order): ${DEFAULT_SLOTS.map(s => s.model).join(', ')}; 2 distinct models from 2 providers.` +
        ` Slot B (${DEFAULT_SLOTS[1]!.model}) scored no question, so it did not judge.` + NOT_CROSS_MODAL,
    },
    // The model shared with slot A never scored in slot C, so its votes did not count twice.
    silentDuplicate: {
      fields: {
        judge_models: [SONNET, OPUS, SONNET], judge_scored_questions: [10, 10, 0],
        distinct_judge_models: 2, distinct_judge_providers: 1,
      },
      note: ` Latest judge panel (slot order): ${SONNET}, ${OPUS}, ${SONNET}; 2 distinct models from 1 provider.` +
        ` Slot C (${SONNET}) scored no question, so it did not judge.` + NOT_CROSS_MODAL,
    },
    // Scored counts of the wrong length are ignored: every slot counts as having judged.
    malformedScoredCounts: {
      fields: {
        judge_models: [SONNET, OPUS, SONNET], judge_scored_questions: [10, 0],
        distinct_judge_models: 2, distinct_judge_providers: 1,
      },
      note: ` Latest judge panel (slot order): ${SONNET}, ${OPUS}, ${SONNET}; 2 distinct models from 1 provider.` + DUPLICATE_NOTE,
    },
  };
  const CASES = (Object.keys(PANELS) as Array<keyof typeof PANELS>).flatMap(panel => [
    { panel, outcome: 'pass', status: 'ok' as const, message: OK + PANELS[panel].note },
    { panel, outcome: 'fail', status: 'warn' as const, message: WARN + PANELS[panel].note },
  ]);

  test.each(CASES)('$panel panel on a $outcome run', async ({ panel, outcome, status, message }) => {
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const check = computeNightlyQualityProbeHealthCheck(true, [{ outcome, ts: TS, ...PANELS[panel].fields }]);
    expect(check.status).toBe(status);
    expect(check.message).toBe(message);
  });

  const UNCHANGED_CASES = [
    { name: 'no panel fields', fields: {} },
    { name: 'judge_models not a list', fields: { judge_models: 'a,b,a', distinct_judge_models: 2, distinct_judge_providers: 1 } },
    { name: 'a non-string judge model', fields: { judge_models: [SONNET, 7, SONNET], distinct_judge_models: 2, distinct_judge_providers: 1 } },
    { name: 'counts missing', fields: { judge_models: [SONNET, OPUS, SONNET] } },
  ];

  test.each(UNCHANGED_CASES)('$name: the messages stay as before', async ({ fields }) => {
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    expect(computeNightlyQualityProbeHealthCheck(true, [{ outcome: 'pass', ts: TS, ...fields }]).message).toBe(OK);
    expect(computeNightlyQualityProbeHealthCheck(true, [{ outcome: 'fail', ts: TS, ...fields }]).message).toBe(WARN);
  });

  test('an audit row in the pre-#5506 shape reads back and renders unchanged', async () => {
    const { computeQualityProbeAuditFilename, readRecentQualityProbeEvents } =
      await import('../src/core/audit-quality-probe.ts');
    const { computeNightlyQualityProbeHealthCheck } = await import('../src/commands/doctor.ts');
    const now = new Date('2026-10-02T12:00:00Z');
    writeFileSync(join(auditTmp, computeQualityProbeAuditFilename(now)), JSON.stringify({
      ts: TS, outcome: 'fail', exit_code: 1, pass_count: 4, fail_count: 6, inconclusive_count: 0,
      error_count: 0, est_cost_usd: 2.8, fixture_sha8: 'abcd1234',
    }) + '\n');
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const events = readRecentQualityProbeEvents(7, now);
      expect(events).toHaveLength(1);
      expect(computeNightlyQualityProbeHealthCheck(true, events).message).toBe(WARN);
    });
  });
});
