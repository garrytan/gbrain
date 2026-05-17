/**
 * v0.36.0.0 (T16) — recall morning pulse calibration footer tests.
 *
 * Pure formatter tests. No engine, no LLM.
 *
 * Tests cover:
 *  - cold-brain branch: null profile → empty string
 *  - insufficient resolved (< 5) → empty string
 *  - happy path: section header + Brier + patterns
 *  - abandoned threads section: optional, formatted, capped at 5
 *  - trend note maps Brier ranges to conversational copy
 *  - patterns capped at 4
 *  - column alignment on abandoned threads
 */

import { describe, test, expect } from 'bun:test';
import { buildRecallCalibrationFooter } from '../src/core/calibration/recall-footer.ts';
import type { CalibrationProfileRow } from '../src/commands/calibration.ts';

function buildProfile(opts: Partial<CalibrationProfileRow> = {}): CalibrationProfileRow {
  return {
    id: 1,
    source_id: 'default',
    holder: 'garry',
    wave_version: 'v0.36.0.0',
    generated_at: '2026-05-17T00:00:00Z',
    published: false,
    total_resolved: 12,
    brier: 0.18,
    accuracy: 0.6,
    partial_rate: 0.1,
    grade_completion: 1.0,
    pattern_statements: ['Right on early-stage tactics, late on macro by 18 months.'],
    active_bias_tags: ['over-confident-geography'],
    voice_gate_passed: true,
    voice_gate_attempts: 1,
    model_id: 'claude-sonnet-4-6',
    ...opts,
  };
}

describe('buildRecallCalibrationFooter — cold-brain branch', () => {
  test('null profile → empty string', () => {
    expect(buildRecallCalibrationFooter({ profile: null })).toBe('');
  });

  test('insufficient resolved (< 5) → empty string', () => {
    expect(buildRecallCalibrationFooter({ profile: buildProfile({ total_resolved: 3 }) })).toBe(
      '',
    );
  });

  test('zero resolved → empty string', () => {
    expect(buildRecallCalibrationFooter({ profile: buildProfile({ total_resolved: 0 }) })).toBe(
      '',
    );
  });
});

describe('buildRecallCalibrationFooter — happy path', () => {
  test('emits header + Brier + pattern block', () => {
    const out = buildRecallCalibrationFooter({ profile: buildProfile() });
    expect(out).toContain('Calibration this quarter:');
    expect(out).toContain('Brier 0.18');
    expect(out).toContain('Right on early-stage tactics');
  });

  test('Brier line includes trend note ("solid")', () => {
    expect(buildRecallCalibrationFooter({ profile: buildProfile({ brier: 0.18 }) })).toContain(
      '(solid)',
    );
  });

  test('Brier near-baseline range', () => {
    expect(
      buildRecallCalibrationFooter({ profile: buildProfile({ brier: 0.24 }) }),
    ).toContain('(near baseline)');
  });

  test('Brier worse than baseline → review hint', () => {
    expect(buildRecallCalibrationFooter({ profile: buildProfile({ brier: 0.32 }) })).toContain(
      'worse than always-50%',
    );
  });

  test('Brier strong calibration', () => {
    expect(
      buildRecallCalibrationFooter({ profile: buildProfile({ brier: 0.08 }) }),
    ).toContain('(strong calibration)');
  });

  test('omits Brier line when brier=null (resolved correct+incorrect = 0)', () => {
    const out = buildRecallCalibrationFooter({ profile: buildProfile({ brier: null }) });
    expect(out).not.toContain('Brier null');
    expect(out).toContain('Calibration this quarter:'); // header still emitted
  });

  test('caps at 4 pattern statements', () => {
    const out = buildRecallCalibrationFooter({
      profile: buildProfile({ pattern_statements: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    });
    const aIdx = out.indexOf(' a\n');
    expect(out).toContain(' a');
    expect(out).toContain(' d');
    // 'e' and 'f' should NOT appear as standalone bullets.
    const lines = out.split('\n');
    const bullets = lines.filter(l => /^ {2}[abcdef]$/.test(l));
    expect(bullets.length).toBe(4);
    void aIdx;
  });
});

describe('buildRecallCalibrationFooter — abandoned threads', () => {
  test('omits the abandoned-threads section when no threads passed', () => {
    const out = buildRecallCalibrationFooter({ profile: buildProfile() });
    expect(out).not.toContain('Threads you opened');
  });

  test('emits section + rows when threads provided', () => {
    const out = buildRecallCalibrationFooter({
      profile: buildProfile(),
      abandonedThreads: [
        { claim: 'AI search platform differentiation', monthsSilent: 17 },
        { claim: 'International expansion playbook', monthsSilent: 12 },
      ],
    });
    expect(out).toContain('Threads you opened and never came back to:');
    expect(out).toContain('AI search platform differentiation');
    expect(out).toContain('17 months silent');
    expect(out).toContain('International expansion playbook');
    expect(out).toContain('12 months silent');
  });

  test('caps at 5 abandoned threads', () => {
    const threads = Array.from({ length: 8 }, (_, i) => ({
      claim: `thread ${i}`,
      monthsSilent: 12 + i,
    }));
    const out = buildRecallCalibrationFooter({ profile: buildProfile(), abandonedThreads: threads });
    expect(out).toContain('thread 0');
    expect(out).toContain('thread 4');
    expect(out).not.toContain('thread 5');
  });

  test('truncates long claim text with ellipsis', () => {
    const longClaim = 'x'.repeat(100);
    const out = buildRecallCalibrationFooter({
      profile: buildProfile(),
      abandonedThreads: [{ claim: longClaim, monthsSilent: 12 }],
      threadColumnWidth: 30,
    });
    expect(out).toContain('x'.repeat(29) + '…');
  });
});
