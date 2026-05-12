/**
 * M7 auto-supersession proposal generator tests.
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyResolution,
  pairToFinding,
  proposeResolution,
  renderResolutionCommand,
} from '../src/core/eval-contradictions/auto-supersession.ts';
import type {
  ContradictionPair,
  JudgeVerdict,
} from '../src/core/eval-contradictions/types.ts';

function mkCrossSlugPair(slugA: string, slugB: string): ContradictionPair {
  return {
    kind: 'cross_slug_chunks',
    a: { slug: slugA, chunk_id: 1, take_id: null, source_tier: 'curated', holder: null, text: 'a' },
    b: { slug: slugB, chunk_id: 2, take_id: null, source_tier: 'bulk', holder: null, text: 'b' },
    combined_score: 1,
  };
}

function mkIntraPagePair(pageSlug: string, takeId: number): ContradictionPair {
  return {
    kind: 'intra_page_chunk_take',
    a: { slug: pageSlug, chunk_id: 5, take_id: null, source_tier: 'curated', holder: null, text: 'chunk text' },
    b: { slug: pageSlug, chunk_id: null, take_id: takeId, source_tier: 'curated', holder: 'garry', text: 'take claim' },
    combined_score: 1,
  };
}

describe('classifyResolution', () => {
  test('intra_page pair → takes_supersede when take_id present', () => {
    const pair = mkIntraPagePair('people/alice', 42);
    expect(classifyResolution(pair, null)).toBe('takes_supersede');
  });

  test('cross_slug + judge hint dream_synthesize → honored', () => {
    const pair = mkCrossSlugPair('companies/acme', 'openclaw/chat/x');
    expect(classifyResolution(pair, 'dream_synthesize')).toBe('dream_synthesize');
  });

  test('cross_slug + judge hint takes_mark_debate → honored', () => {
    const pair = mkCrossSlugPair('originals/talk', 'writing/essay');
    expect(classifyResolution(pair, 'takes_mark_debate')).toBe('takes_mark_debate');
  });

  test('cross_slug + no judge hint + curated entity → dream_synthesize fallback', () => {
    const pair = mkCrossSlugPair('companies/acme', 'openclaw/chat/x');
    expect(classifyResolution(pair, null)).toBe('dream_synthesize');
    const pair2 = mkCrossSlugPair('people/alice', 'daily/2026-05-01');
    expect(classifyResolution(pair2, null)).toBe('dream_synthesize');
  });

  test('cross_slug + neither side is curated entity → manual_review', () => {
    const pair = mkCrossSlugPair('daily/x', 'openclaw/chat/y');
    expect(classifyResolution(pair, null)).toBe('manual_review');
  });

  test('cross_slug + judge hint manual_review honored', () => {
    const pair = mkCrossSlugPair('companies/acme', 'openclaw/chat/x');
    expect(classifyResolution(pair, 'manual_review')).toBe('manual_review');
  });
});

describe('renderResolutionCommand', () => {
  test('takes_supersede emits gbrain takes supersede with row id', () => {
    const pair = mkIntraPagePair('people/alice', 7);
    const cmd = renderResolutionCommand(pair, 'takes_supersede');
    expect(cmd).toBe('gbrain takes supersede people/alice --row 7');
  });

  test('dream_synthesize targets the curated entity side', () => {
    const pair = mkCrossSlugPair('openclaw/chat/x', 'companies/acme');
    const cmd = renderResolutionCommand(pair, 'dream_synthesize');
    expect(cmd).toBe('gbrain dream --phase synthesize --slug companies/acme');
  });

  test('takes_mark_debate emits mark-debate with row id', () => {
    const pair = mkIntraPagePair('people/alice', 12);
    const cmd = renderResolutionCommand(pair, 'takes_mark_debate');
    expect(cmd).toBe('gbrain takes mark-debate people/alice --row 12');
  });

  test('manual_review emits a no-op comment naming both slugs', () => {
    const pair = mkCrossSlugPair('daily/x', 'openclaw/chat/y');
    const cmd = renderResolutionCommand(pair, 'manual_review');
    expect(cmd).toContain('manual review');
    expect(cmd).toContain('daily/x');
    expect(cmd).toContain('openclaw/chat/y');
  });

  test('takes_supersede with missing take_id falls back to row placeholder', () => {
    const pair = mkCrossSlugPair('companies/acme', 'people/alice');
    const cmd = renderResolutionCommand(pair, 'takes_supersede');
    expect(cmd).toContain('<row>');
  });
});

describe('proposeResolution (classify + render combined)', () => {
  test('intra_page → takes_supersede with paste-ready command', () => {
    const pair = mkIntraPagePair('people/alice', 42);
    const p = proposeResolution(pair, null);
    expect(p.resolution_kind).toBe('takes_supersede');
    expect(p.resolution_command).toBe('gbrain takes supersede people/alice --row 42');
  });

  test('cross_slug curated → dream_synthesize on curated slug', () => {
    const pair = mkCrossSlugPair('openclaw/chat/foo', 'companies/acme');
    const p = proposeResolution(pair, null);
    expect(p.resolution_kind).toBe('dream_synthesize');
    expect(p.resolution_command).toBe('gbrain dream --phase synthesize --slug companies/acme');
  });
});

describe('pairToFinding', () => {
  test('merges pair + verdict into a finding', () => {
    const pair = mkIntraPagePair('people/alice', 7);
    const verdict: JudgeVerdict = {
      contradicts: true,
      severity: 'high',
      axis: 'CFO role status',
      confidence: 0.92,
      resolution_kind: 'takes_supersede',
    };
    const finding = pairToFinding(pair, verdict);
    expect(finding.severity).toBe('high');
    expect(finding.axis).toBe('CFO role status');
    expect(finding.confidence).toBe(0.92);
    expect(finding.resolution_kind).toBe('takes_supersede');
    expect(finding.resolution_command).toContain('gbrain takes supersede');
    expect(finding.kind).toBe(pair.kind);
    expect(finding.a).toEqual(pair.a);
    expect(finding.b).toEqual(pair.b);
  });
});
