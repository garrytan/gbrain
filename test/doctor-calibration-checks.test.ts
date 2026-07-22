/**
 * v0.36.1.0 (T12) — calibration doctor check tests.
 *
 * Hermetic. Mock engine + injected executeRaw responses.
 *
 * Tests cover:
 *  - checkAbandonedThreads: zero count → ok; non-zero → ok with count
 *  - checkCalibrationFreshness: missing profile → ok cold-brain; fresh → ok;
 *    stale > 7 days → warn with hint
 *  - checkGradeConfidenceDrift: < 30 applied → ok ("math arrives in v0.37+");
 *    >= 30 → ok placeholder
 *  - checkVoiceGateHealth: 0 in window → ok; high fail rate → warn
 *  - all checks return status='warn' with diagnostic on executeRaw throw
 */

import { describe, test, expect } from 'bun:test';
import {
  checkAbandonedThreads,
  checkCalibrationFreshness,
  checkGradeConfidenceDrift,
  checkVoiceGateHealth,
} from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function buildMockEngine(opts: {
  abandonedCount?: number;
  freshGeneratedAt?: Date | null;
  gradeAppliedCount?: number;
  voiceTotal?: number;
  voiceFailures?: number;
  throwOn?: RegExp;
}): BrainEngine {
  return {
    kind: 'pglite',
    async executeRaw<T>(sql: string): Promise<T[]> {
      if (opts.throwOn && opts.throwOn.test(sql)) {
        throw new Error('mock engine error: ' + sql.slice(0, 50));
      }
      if (sql.includes('FROM takes')) {
        return [{ count: opts.abandonedCount ?? 0 } as unknown as T];
      }
      if (sql.includes('FROM calibration_profiles WHERE holder')) {
        return [{ generated_at: opts.freshGeneratedAt ?? null } as unknown as T];
      }
      if (sql.includes('FROM take_grade_cache')) {
        return [{ applied_count: opts.gradeAppliedCount ?? 0 } as unknown as T];
      }
      if (sql.includes('FROM calibration_profiles\n         WHERE generated_at')) {
        return [
          {
            total: opts.voiceTotal ?? 0,
            failures: opts.voiceFailures ?? 0,
          } as unknown as T,
        ];
      }
      return [] as T[];
    },
  } as unknown as BrainEngine;
}

// ─── abandoned_threads ──────────────────────────────────────────────

describe('checkAbandonedThreads', () => {
  test('zero count → ok with no-abandoned message', async () => {
    const out = await checkAbandonedThreads(buildMockEngine({ abandonedCount: 0 }));
    expect(out.status).toBe('ok');
    expect(out.message).toContain('No abandoned high-conviction threads');
  });

  test('non-zero count → ok with count + hint', async () => {
    const out = await checkAbandonedThreads(buildMockEngine({ abandonedCount: 4 }));
    expect(out.status).toBe('ok');
    expect(out.message).toContain('4 high-conviction take(s)');
    expect(out.message).toContain('gbrain calibration');
  });

  test('engine throw → warn with diagnostic (non-blocking)', async () => {
    const out = await checkAbandonedThreads(buildMockEngine({ throwOn: /FROM takes/ }));
    expect(out.status).toBe('warn');
    expect(out.message).toContain('Could not check abandoned threads');
  });
});

// ─── calibration_freshness ──────────────────────────────────────────

describe('checkCalibrationFreshness', () => {
  test('no profile yet → ok cold-brain message', async () => {
    const out = await checkCalibrationFreshness(buildMockEngine({ freshGeneratedAt: null }));
    expect(out.status).toBe('ok');
    expect(out.message).toContain('No calibration profile yet');
  });

  test('fresh profile (1 day old) → ok', async () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const out = await checkCalibrationFreshness(buildMockEngine({ freshGeneratedAt: d }));
    expect(out.status).toBe('ok');
    expect(out.message).toContain('1d ago');
  });

  test('stale profile (>7 days) → warn with regenerate hint', async () => {
    const d = new Date();
    d.setDate(d.getDate() - 10);
    const out = await checkCalibrationFreshness(buildMockEngine({ freshGeneratedAt: d }));
    expect(out.status).toBe('warn');
    expect(out.message).toContain('10 days old');
    expect(out.message).toContain('gbrain calibration --regenerate');
  });

  test('boundary: 7 days old → still ok (NOT warn)', async () => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    d.setMinutes(d.getMinutes() + 1); // slightly less than 7 full days
    const out = await checkCalibrationFreshness(buildMockEngine({ freshGeneratedAt: d }));
    expect(out.status).toBe('ok');
  });

  test('engine throw → warn with diagnostic', async () => {
    const out = await checkCalibrationFreshness(
      buildMockEngine({ throwOn: /FROM calibration_profiles WHERE holder/ }),
    );
    expect(out.status).toBe('warn');
    expect(out.message).toContain('Could not check calibration freshness');
  });
});

// ─── grade_confidence_drift ─────────────────────────────────────────

describe('checkGradeConfidenceDrift', () => {
  test('fewer than 30 applied → ok placeholder', async () => {
    const out = await checkGradeConfidenceDrift(buildMockEngine({ gradeAppliedCount: 12 }));
    expect(out.status).toBe('ok');
    expect(out.message).toContain('12 auto-applied verdicts');
    expect(out.message).toContain('need 30');
  });

  test('>= 30 applied → ok placeholder with math-pending note', async () => {
    const out = await checkGradeConfidenceDrift(buildMockEngine({ gradeAppliedCount: 50 }));
    expect(out.status).toBe('ok');
    expect(out.message).toContain('50 auto-applied verdicts');
    expect(out.message).toContain('v0.37');
  });

  test('engine throw → warn with diagnostic', async () => {
    const out = await checkGradeConfidenceDrift(buildMockEngine({ throwOn: /FROM take_grade_cache/ }));
    expect(out.status).toBe('warn');
    expect(out.message).toContain('Could not check grade confidence drift');
  });
});

// ─── voice_gate_health ──────────────────────────────────────────────

describe('checkVoiceGateHealth', () => {
  test('no profile in window → ok', async () => {
    const out = await checkVoiceGateHealth(buildMockEngine({ voiceTotal: 0, voiceFailures: 0 }));
    expect(out.status).toBe('ok');
    expect(out.message).toContain('No calibration profile generation');
  });

  test('low fail rate → ok', async () => {
    const out = await checkVoiceGateHealth(
      buildMockEngine({ voiceTotal: 10, voiceFailures: 1 }),
    );
    expect(out.status).toBe('ok');
    expect(out.message).toContain('1/10 failed');
  });

  test('30%+ fail rate → warn with rubric-review hint', async () => {
    const out = await checkVoiceGateHealth(
      buildMockEngine({ voiceTotal: 10, voiceFailures: 4 }),
    );
    expect(out.status).toBe('warn');
    expect(out.message).toContain('4/10');
    expect(out.message).toContain('voice-gate.ts');
  });

  test('engine throw → warn with diagnostic', async () => {
    const out = await checkVoiceGateHealth(
      buildMockEngine({ throwOn: /WHERE generated_at/ }),
    );
    expect(out.status).toBe('warn');
    expect(out.message).toContain('Could not check voice gate health');
  });
});
