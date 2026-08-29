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
    a: { slug: slugA, chunk_id: 1, take_id: null, take_row_num: null, source_tier: 'curated', holder: null, text: 'a', effective_date: null, effective_date_source: null },
    b: { slug: slugB, chunk_id: 2, take_id: null, take_row_num: null, source_tier: 'bulk', holder: null, text: 'b', effective_date: null, effective_date_source: null },
    combined_score: 1,
  };
}

function mkIntraPagePair(pageSlug: string, takeId: number, takeRowNum: number | null = 2): ContradictionPair {
  return {
    kind: 'intra_page_chunk_take',
    a: { slug: pageSlug, chunk_id: 5, take_id: null, take_row_num: null, source_tier: 'curated', holder: null, text: 'chunk text', effective_date: null, effective_date_source: null },
    b: { slug: pageSlug, chunk_id: null, take_id: takeId, take_row_num: takeRowNum, source_tier: 'curated', holder: 'garry', text: 'take claim', effective_date: null, effective_date_source: null },
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

  test('cross_slug + judge hint takes_mark_debate → manual_review (gbrain#4169: the subcommand does not exist, tracked in #4102)', () => {
    const pair = mkCrossSlugPair('originals/talk', 'writing/essay');
    expect(classifyResolution(pair, 'takes_mark_debate')).toBe('manual_review');
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
  test('gbrain#4169 — takes_supersede addresses --row with the PER-PAGE row_num, not the global take id', () => {
    // take_id 7 (global PK) vs row_num 2 (what the CLI resolves): the pre-fix
    // command `--row 7` errored "Row #7 not found" on every generated
    // resolution. --claim is required by cmdSupersede; a chunk-vs-take pair
    // has no unambiguous winner claim, so an explicit placeholder renders.
    const pair = mkIntraPagePair('people/alice', 7, 2);
    const cmd = renderResolutionCommand(pair, 'takes_supersede');
    expect(cmd).toBe(`gbrain takes supersede 'people/alice' --row 2 --claim '<replacement claim — see contradiction report>'`);
    expect(cmd).not.toContain('--row 7');
  });

  test('dream_synthesize targets the curated entity side', () => {
    const pair = mkCrossSlugPair('openclaw/chat/x', 'companies/acme');
    const cmd = renderResolutionCommand(pair, 'dream_synthesize');
    expect(cmd).toBe(`gbrain dream --phase synthesize --slug 'companies/acme'`);
  });

  test('gbrain#4169 — legacy takes_mark_debate rows render a truthful manual-review hint (subcommand does not exist)', () => {
    const pair = mkIntraPagePair('people/alice', 12, 3);
    const cmd = renderResolutionCommand(pair, 'takes_mark_debate');
    expect(cmd).toContain('# manual review');
    expect(cmd).toContain('#4102');
    expect(cmd).toContain('row 3');
    expect(cmd).not.toContain('gbrain takes mark-debate');
  });

  test('gbrain#4169 — temporal_supersede with a take winner renders paste-ready with the shell-escaped winning claim', () => {
    const pair: ContradictionPair = {
      kind: 'intra_page_chunk_take',
      a: { slug: 'people/alice', chunk_id: null, take_id: 40, take_row_num: 1, source_tier: 'curated', holder: 'garry', text: "old take: it's the CFO's call", effective_date: '2025-01-01', effective_date_source: 'frontmatter' },
      b: { slug: 'people/alice', chunk_id: null, take_id: 41, take_row_num: 4, source_tier: 'curated', holder: 'garry', text: "newer take: it's the CEO's call", effective_date: '2026-02-02', effective_date_source: 'frontmatter' },
      combined_score: 1,
    };
    const cmd = renderResolutionCommand(pair, 'temporal_supersede');
    // Older side (row 1) superseded; the newer take's claim is the winner —
    // single-quoted with embedded apostrophes spliced ('\'').
    expect(cmd).toContain(`gbrain takes supersede 'people/alice' --row 1 --claim `);
    expect(cmd).toContain('--since 2026-02-02');
    expect(cmd).toContain(`newer take: it'\\''s the CEO'\\''s call`);
  });

  test('gbrain#4169 — temporal_supersede with a chunk winner keeps the claim placeholder (no fabricated take)', () => {
    const pair: ContradictionPair = {
      kind: 'intra_page_chunk_take',
      a: { slug: 'people/alice', chunk_id: null, take_id: 40, take_row_num: 1, source_tier: 'curated', holder: 'garry', text: 'old take', effective_date: '2025-01-01', effective_date_source: 'frontmatter' },
      b: { slug: 'people/alice', chunk_id: 9, take_id: null, take_row_num: null, source_tier: 'curated', holder: null, text: 'arbitrary chunk prose', effective_date: '2026-02-02', effective_date_source: 'frontmatter' },
      combined_score: 1,
    };
    const cmd = renderResolutionCommand(pair, 'temporal_supersede');
    expect(cmd).toContain('--row 1');
    expect(cmd).toContain('<replacement claim');
    expect(cmd).not.toContain('arbitrary chunk prose');
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
  test('intra_page → takes_supersede addressed by row_num with an explicit claim placeholder (gbrain#4169)', () => {
    const pair = mkIntraPagePair('people/alice', 42, 5);
    const p = proposeResolution(pair, null);
    expect(p.resolution_kind).toBe('takes_supersede');
    expect(p.resolution_command).toBe(`gbrain takes supersede 'people/alice' --row 5 --claim '<replacement claim — see contradiction report>'`);
  });

  test('cross_slug curated → dream_synthesize on curated slug', () => {
    const pair = mkCrossSlugPair('openclaw/chat/foo', 'companies/acme');
    const p = proposeResolution(pair, null);
    expect(p.resolution_kind).toBe('dream_synthesize');
    expect(p.resolution_command).toBe(`gbrain dream --phase synthesize --slug 'companies/acme'`);
  });
});

describe('pairToFinding', () => {
  test('merges pair + verdict into a finding', () => {
    const pair = mkIntraPagePair('people/alice', 7);
    const verdict: JudgeVerdict = {
      verdict: 'contradiction',
      severity: 'high',
      axis: 'CFO role status',
      confidence: 0.92,
      resolution_kind: 'takes_supersede',
    };
    const finding = pairToFinding(pair, verdict);
    expect(finding.verdict).toBe('contradiction');
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
