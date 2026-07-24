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
