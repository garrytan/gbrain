/**
 * v0.40.1.0 Track D / T6+T7 — Nightly quality probe phase + doctor check.
 *
 * Hermetic: every external effect goes through the NightlyProbeDeps DI
 * surface. No PGLite, no real LLM calls, no env mutation outside withEnv.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  resolveNightlyProbeBatchSize,
  runNightlyQualityProbe,
  selectNightlyFixtureBatch,
  shouldRunNightly,
  validateNightlyProbeSummary,
  type NightlyProbeBatchSummary,
  type NightlyProbeDeps,
  type NightlyProbeResult,
} from '../src/core/cycle/nightly-quality-probe.ts';
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

describe('nightly fixture budget + audit-cursor rotation (pure)', () => {
  const fixture = [
    JSON.stringify({ question_id: 'nightly-a', question: 'a' }),
    JSON.stringify({ question_id: 'nightly-b', question: 'b' }),
    JSON.stringify({ question_id: 'nightly-c', question: 'c' }),
  ].join('\n');

  test('$0.20 affords one default cross-modal question; $5 preserves all 10', () => {
    expect(resolveNightlyProbeBatchSize(0.2, 10)).toEqual({
      count: 1,
      perQuestionUsd: 0.2,
    });
    expect(resolveNightlyProbeBatchSize(5, 10)).toEqual({
      count: 10,
      perQuestionUsd: 0.2,
    });
    expect(resolveNightlyProbeBatchSize(0.19, 10).count).toBe(0);
  });

  test('summary completion requires both total and outcome counts to match selection', () => {
    expect(validateNightlyProbeSummary(completeSummary(1), 1)).toEqual({ valid: true });
    expect(validateNightlyProbeSummary(completeSummary(1, { total: 0 }), 1))
      .toMatchObject({ valid: false });
    expect(validateNightlyProbeSummary(completeSummary(1, { pass_count: 0 }), 1))
      .toMatchObject({ valid: false });
  });

  test('starts at fixture index 0 when no matching audit cursor exists', () => {
    const selected = selectNightlyFixtureBatch(fixture, 2, [], 'fixture-a');

    expect(selected.questionIds).toEqual(['nightly-a', 'nightly-b']);
    expect(selected.startIndex).toBe(0);
    expect(selected.lastIndex).toBe(1);
    expect(selected.count).toBe(2);
    expect(selected.total).toBe(3);
  });

  test('a delayed run continues after the last audited index instead of skipping by date', () => {
    const selected = selectNightlyFixtureBatch(fixture, 1, [{
      ts: '2026-07-01T00:00:00Z',
      fixture_sha8: 'fixture-a',
      question_index: 0,
      question_total: 3,
    }], 'fixture-a');

    expect(selected.questionIds).toEqual(['nightly-b']);
    expect(selected.startIndex).toBe(1);
    expect(selected.lastIndex).toBe(1);
  });

  test('wraps after the final index and resets when fixture identity changes', () => {
    const cursor = [{
      ts: '2026-07-01T00:00:00Z',
      fixture_sha8: 'fixture-a',
      question_index: 2,
      question_total: 3,
    }];

    expect(selectNightlyFixtureBatch(fixture, 1, cursor, 'fixture-a').questionIds)
      .toEqual(['nightly-a']);
    expect(selectNightlyFixtureBatch(fixture, 1, cursor, 'fixture-b').questionIds)
      .toEqual(['nightly-a']);
  });
});

// ---------------------------------------------------------------------------
// 2. runNightlyQualityProbe via DI stubs
// ---------------------------------------------------------------------------

function completeSummary(
  count: number,
  overrides: Partial<NightlyProbeBatchSummary> = {},
): NightlyProbeBatchSummary {
  return {
    total: count,
    pass_count: count,
    fail_count: 0,
    inconclusive_count: 0,
    error_count: 0,
    upstream_error_count: 0,
    malformed_count: 0,
    est_cost_usd: count * 0.2,
    verdict: 'pass',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<NightlyProbeDeps> = {}): NightlyProbeDeps {
  return {
    isEnabled: async () => true,
    hasEmbeddingProvider: async () => true,
    resolveMaxUsd: async () => 5,
    resolveRepoRoot: async () => process.cwd(),
    runLongMemEval: async () => { /* stub */ },
    runCrossModalBatch: async () => ({
      exitCode: 0,
      summary: completeSummary(10),
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
      expect(events[0].pass_count).toBe(10);
      expect(events[0].est_cost_usd).toBe(2);
    });
  });

  test('default $5 budget passes all 10 fixture rows and audits the cursor', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      let selectedRows: string[] = [];
      let judgeLimit = 0;
      const r = await runNightlyQualityProbe(makeDeps({
        runLongMemEval: async ({ fixturePath }) => {
          selectedRows = readFileSync(fixturePath, 'utf8')
            .split(/\r?\n/)
            .filter(Boolean);
        },
        runCrossModalBatch: async ({ limit }) => {
          judgeLimit = limit;
          return { exitCode: 0, summary: completeSummary(10) };
        },
      }));

      expect(r.outcome).toBe('pass');
      expect(selectedRows).toHaveLength(10);
      expect(judgeLimit).toBe(10);
      expect(selectedRows.map(row => JSON.parse(row).question_id))
        .toEqual(Array.from({ length: 10 }, (_, index) => `nightly-${index + 1}`));
      const [event] = await readEvents();
      expect(event.question_id).toBe('nightly-10');
      expect(event.question_ids).toEqual(
        Array.from({ length: 10 }, (_, index) => `nightly-${index + 1}`),
      );
      expect(event.question_index).toBe(9);
      expect(event.question_count).toBe(10);
      expect(event.question_total).toBe(10);
    });
  });

  test('fixture larger than 10 passes the full affordable selection as explicit --limit', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const repoRoot = join(auditTmp, 'large-fixture-repo');
      const fixtureDir = join(repoRoot, 'test', 'fixtures');
      mkdirSync(fixtureDir, { recursive: true });
      const fixtureRows = Array.from({ length: 30 }, (_, index) => JSON.stringify({
        question_id: `nightly-large-${index + 1}`,
        question: `Question ${index + 1}`,
      }));
      writeFileSync(join(fixtureDir, 'longmemeval-nightly.jsonl'), `${fixtureRows.join('\n')}\n`);

      const affordable = resolveNightlyProbeBatchSize(5, fixtureRows.length).count;
      expect(affordable).toBeGreaterThan(10);
      let selectedCount = 0;
      let judgeLimit = 0;
      const r = await runNightlyQualityProbe(makeDeps({
        resolveRepoRoot: async () => repoRoot,
        runLongMemEval: async ({ fixturePath }) => {
          selectedCount = readFileSync(fixturePath, 'utf8').split(/\r?\n/).filter(Boolean).length;
        },
        runCrossModalBatch: async ({ limit }) => {
          judgeLimit = limit;
          return { exitCode: 0, summary: completeSummary(affordable) };
        },
      }));

      expect(r.outcome).toBe('pass');
      expect(selectedCount).toBe(affordable);
      expect(judgeLimit).toBe(affordable);
      const [event] = await readEvents();
      expect(event.question_id).toBe(`nightly-large-${affordable}`);
      expect(event.question_index).toBe(affordable - 1);
      expect(event.question_count).toBe(affordable);
      expect(event.question_total).toBe(30);
    });
  });

  test('$0.20 selects one row and a run delayed by 72h continues at the next audit index', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      let now = new Date();
      const batches: string[][] = [];
      const deps = makeDeps({
        resolveMaxUsd: async () => 0.2,
        now: () => now,
        runLongMemEval: async ({ fixturePath }) => {
          batches.push(
            readFileSync(fixturePath, 'utf8')
              .split(/\r?\n/)
              .filter(Boolean)
              .map(row => JSON.parse(row).question_id),
          );
        },
        runCrossModalBatch: async () => ({
          exitCode: 0,
          summary: completeSummary(1),
        }),
      });

      expect((await runNightlyQualityProbe(deps)).outcome).toBe('pass');
      now = new Date(now.getTime() + 72 * 60 * 60 * 1000);
      expect((await runNightlyQualityProbe(deps)).outcome).toBe('pass');

      expect(batches).toEqual([['nightly-1'], ['nightly-2']]);
      const events = await readEvents();
      expect(events.map(event => event.question_id)).toEqual(['nightly-1', 'nightly-2']);
      expect(events.map(event => event.question_index)).toEqual([0, 1]);
      expect(events.every(event => event.question_total === 10)).toBe(true);
    });
  });

  test('incomplete summary is an error, omits the cursor, and retries the same question', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      let now = new Date();
      let judgeCalls = 0;
      const batches: string[][] = [];
      const deps = makeDeps({
        resolveMaxUsd: async () => 0.2,
        now: () => now,
        runLongMemEval: async ({ fixturePath }) => {
          batches.push(
            readFileSync(fixturePath, 'utf8')
              .split(/\r?\n/)
              .filter(Boolean)
              .map(row => JSON.parse(row).question_id),
          );
        },
        runCrossModalBatch: async () => {
          judgeCalls++;
          return judgeCalls === 1
            ? { exitCode: 0, summary: completeSummary(1, { total: 0 }) }
            : { exitCode: 0, summary: completeSummary(1) };
        },
      });

      const first = await runNightlyQualityProbe(deps);
      expect(first.outcome).toBe('error');
      expect(first.detail).toContain('does not match selected fixture count');
      now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
      expect((await runNightlyQualityProbe(deps)).outcome).toBe('pass');

      expect(batches).toEqual([['nightly-1'], ['nightly-1']]);
      const events = await readEvents();
      expect(events[0].question_ids).toEqual(['nightly-1']);
      expect(events[0].question_id).toBeUndefined();
      expect(events[0].question_index).toBeUndefined();
      expect(events[1].question_id).toBe('nightly-1');
      expect(events[1].question_index).toBe(0);
    });
  });

  test('budget below one estimated question short-circuits before LongMemEval', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      let lmeCalls = 0;
      let judgeCalls = 0;
      const r = await runNightlyQualityProbe(makeDeps({
        resolveMaxUsd: async () => 0.19,
        runLongMemEval: async () => { lmeCalls++; },
        runCrossModalBatch: async () => {
          judgeCalls++;
          return { exitCode: 1 };
        },
      }));

      expect(r.outcome).toBe('budget_exceeded');
      expect(lmeCalls).toBe(0);
      expect(judgeCalls).toBe(0);
      const [event] = await readEvents();
      expect(event.outcome).toBe('budget_exceeded');
      expect(event.question_count).toBe(0);
      expect(event.question_total).toBe(10);
      expect(event.question_id).toBeUndefined();
    });
  });

  test('exit 1 without a summary is an ambiguous runtime error and retries the same question', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      let now = new Date();
      let judgeCalls = 0;
      const batches: string[][] = [];
      const deps = makeDeps({
        resolveMaxUsd: async () => 0.2,
        now: () => now,
        runLongMemEval: async ({ fixturePath }) => {
          batches.push(
            readFileSync(fixturePath, 'utf8')
              .split(/\r?\n/)
              .filter(Boolean)
              .map(row => JSON.parse(row).question_id),
          );
        },
        runCrossModalBatch: async () => {
          judgeCalls++;
          return judgeCalls === 1
            ? { exitCode: 1 }
            : { exitCode: 0, summary: completeSummary(1) };
        },
      });

      expect((await runNightlyQualityProbe(deps)).outcome).toBe('error');
      now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
      expect((await runNightlyQualityProbe(deps)).outcome).toBe('pass');

      expect(batches).toEqual([['nightly-1'], ['nightly-1']]);
      const events = await readEvents();
      expect(events[0].outcome).toBe('error');
      expect(events[0].question_ids).toEqual(['nightly-1']);
      expect(events[0].question_id).toBeUndefined();
      expect(events[0].question_index).toBeUndefined();
      expect(events[1].question_id).toBe('nightly-1');
      expect(events[1].question_index).toBe(0);
    });
  });

  test('enabled + FAIL summary → outcome: fail', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps({
        runCrossModalBatch: async () => ({
          exitCode: 1,
          summary: completeSummary(10, {
            pass_count: 7, fail_count: 3, inconclusive_count: 0, error_count: 0,
            est_cost_usd: 0.42, verdict: 'fail',
          }),
        }),
      }));
      expect(r.outcome).toBe('fail');
      expect(r.exit_code).toBe(1);
      const events = await readEvents();
      expect(events[0].outcome).toBe('fail');
      expect(events[0].fail_count).toBe(3);
    });
  });

  test('LongMemEval throw audits the attempt without a cursor and retries the same question', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      let now = new Date();
      let lmeCalls = 0;
      const batches: string[][] = [];
      const deps = makeDeps({
        resolveMaxUsd: async () => 0.2,
        now: () => now,
        runLongMemEval: async ({ fixturePath }) => {
          lmeCalls++;
          batches.push(
            readFileSync(fixturePath, 'utf8')
              .split(/\r?\n/)
              .filter(Boolean)
              .map(row => JSON.parse(row).question_id),
          );
          if (lmeCalls === 1) throw new Error('longmemeval blew up');
        },
        runCrossModalBatch: async () => ({
          exitCode: 0,
          summary: completeSummary(1),
        }),
      });

      expect((await runNightlyQualityProbe(deps)).outcome).toBe('error');
      now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
      expect((await runNightlyQualityProbe(deps)).outcome).toBe('pass');

      expect(batches).toEqual([['nightly-1'], ['nightly-1']]);
      const events = await readEvents();
      expect(events[0].detail).toContain('longmemeval blew up');
      expect(events[0].question_ids).toEqual(['nightly-1']);
      expect(events[0].question_id).toBeUndefined();
      expect(events[0].question_index).toBeUndefined();
      expect(events[1].question_id).toBe('nightly-1');
      expect(events[1].question_index).toBe(0);
    });
  });

  test('missing fixture → outcome: error', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps({
        resolveRepoRoot: async () => '/this/repo/root/does/not/exist',
      }));
      expect(r.outcome).toBe('error');
      const events = await readEvents();
      expect(events[0].outcome).toBe('error');
      expect(events[0].detail).toContain('not found');
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
