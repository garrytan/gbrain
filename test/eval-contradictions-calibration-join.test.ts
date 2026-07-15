/**
 * v0.36.1.0 (T9 / E3) — calibration-aware contradictions tests.
 *
 * Pure-function tests for the calibration-join helper. No DB, no LLM.
 *
 * Tests cover:
 *  - R2 regression: no profile → null tag (contradictions output unchanged)
 *  - happy path: finding matches active bias tag via domain hint
 *  - geography hint matches over-confident-geography tag
 *  - macro hint matches late-on-macro-tech tag
 *  - mismatch: hint produced but tag set doesn't include matching slug
 *  - empty active_bias_tags: returns null (no false positives)
 *  - bias context string contains tag name + Brier when present
 */

import { describe, test, expect } from 'bun:test';
import {
  tagFindingWithCalibration,
  computeDomainHint,
  buildBiasContextString,
} from '../src/core/eval-contradictions/calibration-join.ts';
import type { ContradictionFinding, PairMember } from '../src/core/eval-contradictions/types.ts';
import type { CalibrationProfileRow } from '../src/commands/calibration.ts';

function buildMember(slug: string, holder: string | null = 'garry'): PairMember {
  return {
    slug,
    chunk_id: 1,
    take_id: null,
    source_tier: 'curated',
    holder,
    text: 'some text',
    effective_date: '2024-01-01',
    effective_date_source: 'frontmatter',
  };
}

function buildFinding(slugA: string, slugB: string): ContradictionFinding {
  return {
    kind: 'cross_slug_chunks',
    a: buildMember(slugA),
    b: buildMember(slugB),
    combined_score: 0.85,
    verdict: 'contradiction',
    severity: 'medium',
    axis: 'evidence',
    confidence: 0.8,
    resolution_kind: 'manual_review',
    resolution_command: 'gbrain takes resolve N --quality incorrect',
  };
}

function buildProfile(activeTags: string[], brier: number | null = 0.21): CalibrationProfileRow {
  return {
    id: 1,
    source_id: 'default',
    holder: 'garry',
    wave_version: 'v0.36.1.0',
    generated_at: '2026-05-17T00:00:00Z',
    published: false,
    total_resolved: 12,
    brier,
    accuracy: 0.6,
    partial_rate: 0.1,
    grade_completion: 1.0,
    pattern_statements: ['something'],
    active_bias_tags: activeTags,
    voice_gate_passed: true,
    voice_gate_attempts: 1,
    model_id: 'claude-sonnet-4-6',
  };
}

// ─── R2 regression: no profile → byte-identical output ──────────────

describe('tagFindingWithCalibration — R2 regression', () => {
  test('null profile returns null tag (contradictions output unchanged)', () => {
    const finding = buildFinding('wiki/companies/acme-example', 'wiki/companies/widget-co');
    expect(tagFindingWithCalibration(finding, null)).toBeNull();
  });

  test('profile with empty active_bias_tags returns null', () => {
    const finding = buildFinding('wiki/companies/acme', 'wiki/companies/widget');
    expect(tagFindingWithCalibration(finding, buildProfile([]))).toBeNull();
  });
});

// ─── computeDomainHint ──────────────────────────────────────────────

describe('computeDomainHint', () => {
  test('companies slug → hiring/market-timing hint', () => {
    expect(computeDomainHint(buildFinding('wiki/companies/a', 'wiki/companies/b'))).toMatch(/hiring|market-timing/);
  });

  test('people slug → founder-behavior hint', () => {
    expect(computeDomainHint(buildFinding('wiki/people/a', 'wiki/people/b'))).toMatch(/founder-behavior|hiring/);
  });

  test('macro slug → macro hint', () => {
    expect(computeDomainHint(buildFinding('wiki/macro/forecast', 'wiki/macro/timing'))).toBe('macro');
  });

  test('geography slug → geography hint', () => {
    expect(computeDomainHint(buildFinding('wiki/geography/ny', 'wiki/geography/sf'))).toBe('geography');
  });

  test('unrecognized slug → empty hint', () => {
    expect(computeDomainHint(buildFinding('wiki/random/x', 'wiki/random/y'))).toBe('');
  });
});

// ─── Happy path: tag matches ────────────────────────────────────────

describe('tagFindingWithCalibration — match path', () => {
  test('macro finding matches "late-on-macro-tech" tag', () => {
    const finding = buildFinding('wiki/macro/forecast-2024', 'wiki/macro/forecast-2026');
    const profile = buildProfile(['late-on-macro-tech']);
    const tag = tagFindingWithCalibration(finding, profile);
    expect(tag).not.toBeNull();
    expect(tag!.bias_tag).toBe('late-on-macro-tech');
    expect(tag!.context).toContain('late-on-macro-tech');
  });

  test('geography finding matches "over-confident-geography" tag', () => {
    const finding = buildFinding('wiki/geography/ny-tech', 'wiki/geography/sf-tech');
    const profile = buildProfile(['over-confident-geography']);
    const tag = tagFindingWithCalibration(finding, profile);
    expect(tag).not.toBeNull();
    expect(tag!.bias_tag).toBe('over-confident-geography');
  });

  test('mismatch: companies finding does NOT match macro-only tag', () => {
    const finding = buildFinding('wiki/companies/acme', 'wiki/companies/widget');
    // Active tag is macro only; companies hint is hiring/market-timing, not macro.
    const profile = buildProfile(['late-on-macro-tech']);
    const tag = tagFindingWithCalibration(finding, profile);
    expect(tag).toBeNull();
  });

  test('first-match-wins when multiple tags could match the hint', () => {
    const finding = buildFinding('wiki/companies/acme', 'wiki/companies/widget');
    const profile = buildProfile(['over-confident-hiring', 'under-calibrated-market-timing']);
    const tag = tagFindingWithCalibration(finding, profile);
    expect(tag).not.toBeNull();
    // companies → first candidate is 'hiring'; the tag containing 'hiring' wins.
    expect(tag!.bias_tag).toBe('over-confident-hiring');
  });
});

// ─── buildBiasContextString ─────────────────────────────────────────

describe('buildBiasContextString', () => {
  test('emits tag name + verdict + severity + Brier', () => {
    const finding = buildFinding('wiki/companies/acme', 'wiki/companies/widget');
    const profile = buildProfile(['over-confident-hiring'], 0.31);
    const ctx = buildBiasContextString('over-confident-hiring', finding, profile);
    expect(ctx).toContain('over-confident-hiring');
    expect(ctx).toContain('contradiction'); // verdict
    expect(ctx).toContain('medium'); // severity
    expect(ctx).toContain('Brier 0.31');
  });

  test('omits Brier when null', () => {
    const finding = buildFinding('wiki/companies/acme', 'wiki/companies/widget');
    const profile = buildProfile(['over-confident-hiring'], null);
    const ctx = buildBiasContextString('over-confident-hiring', finding, profile);
    expect(ctx).not.toContain('Brier null');
    expect(ctx).not.toContain('Brier NaN');
  });
});
