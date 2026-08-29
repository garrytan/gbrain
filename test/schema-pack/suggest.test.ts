/**
 * test/schema-pack/suggest.test.ts — runSuggest (src/core/schema-pack/suggest.ts)
 * through the `opts.suggestFn` seam plus the hermetic heuristic fallback.
 *
 * The public reshape is the contract downstream consumers (T3 CLI, dream
 * cycle, EIIRP, doctor) rely on: confidence clamped into [0,1], summary-keyed
 * dedup keeping the FIRST occurrence, descending-confidence sort, evidence
 * defaulting to []. The load-bearing pair: the no-LLM heuristic fallback
 * emits at confidence EXACTLY 0.5, strictly below the 0.6 auto-apply floor
 * (codex finding #9: consumers MUST treat < 0.6 as manual-review-only), so a
 * keyless install can never auto-apply a schema change. 0.6 exists only as a
 * documented contract (suggest.ts comment, skills/eiirp/SKILL.md,
 * eval-schema-authoring's low_confidence_count) — the source-text guard below
 * pins both literals so neither side can drift alone.
 *
 * The heuristic tests intentionally pass NO suggestFn: every branch of the
 * gateway probe (no provider / provider-but-deferred / import failure) routes
 * to heuristicSuggestions today, so the path is deterministic without env
 * setup. Engine access is stubbed at the executeRaw seam runDetect uses
 * (totals / prefix-distribution / type-distribution, routed on SQL text).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runSuggest, type RawSuggestion, type SuggestPromptInput } from '../../src/core/schema-pack/suggest.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

interface DetectRows {
  total?: number;
  untyped?: number;
  typed?: number;
  prefixes?: Array<{ prefix: string; cnt: string; sample_types: string[] | null }>;
  types?: Array<{ type: string; cnt: string }>;
}

/** Stub the three executeRaw calls runDetect issues, routed on SQL text. */
function detectEngine(rows: DetectRows = {}): BrainEngine {
  return {
    executeRaw: async (sql: string) => {
      if (sql.includes('FILTER (WHERE type IS NULL')) {
        return [
          {
            total: String(rows.total ?? 0),
            untyped: String(rows.untyped ?? 0),
            typed: String(rows.typed ?? 0),
          },
        ];
      }
      if (sql.includes('substring(slug from')) return rows.prefixes ?? [];
      return rows.types ?? [];
    },
  } as unknown as BrainEngine;
}

function raw(over: Partial<RawSuggestion> & { summary: string }): RawSuggestion {
  return { kind: 'add_type', confidence: 0.5, ...over };
}

describe('runSuggest — confidence clamping into [0,1]', () => {
  test('NaN→0, Infinity→0 (non-finite is no-confidence, NOT 1), -5→0, 2.0→1, 0.7 passes through', async () => {
    const result = await runSuggest(detectEngine(), {
      suggestFn: async () => [
        raw({ summary: 's-nan', confidence: NaN }),
        raw({ summary: 's-inf', confidence: Infinity }),
        raw({ summary: 's-neg', confidence: -5 }),
        raw({ summary: 's-two', confidence: 2.0 }),
        raw({ summary: 's-mid', confidence: 0.7 }),
      ],
    });
    const bySummary = Object.fromEntries(result.suggestions.map((s) => [s.summary, s.confidence]));
    expect(bySummary).toEqual({
      's-nan': 0,
      // Number.isFinite gates BEFORE the min/max clamp, so Infinity takes the
      // same 0 default as NaN rather than clamping to 1 — pinned reality.
      's-inf': 0,
      's-neg': 0,
      's-two': 1,
      's-mid': 0.7,
    });
    for (const s of result.suggestions) {
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('runSuggest — summary-keyed dedup keeps the FIRST occurrence', () => {
  test('a later duplicate summary is dropped even when it carries higher confidence', async () => {
    const result = await runSuggest(detectEngine(), {
      suggestFn: async () => [
        raw({ summary: 'dup', kind: 'add_type', confidence: 0.3 }),
        raw({ summary: 'dup', kind: 'rename', confidence: 0.9 }),
        raw({ summary: 'other', kind: 'add_alias', confidence: 0.5 }),
      ],
    });
    expect(result.suggestions).toHaveLength(2);
    const dup = result.suggestions.find((s) => s.summary === 'dup')!;
    expect(dup.kind).toBe('add_type'); // the FIRST one, not the higher-confidence one
    expect(dup.confidence).toBe(0.3);
  });
});

describe('runSuggest — output ordering and evidence default', () => {
  test('results are sorted descending by (clamped) confidence', async () => {
    const result = await runSuggest(detectEngine(), {
      suggestFn: async () => [
        raw({ summary: 'low', confidence: 0.1 }),
        raw({ summary: 'high', confidence: 0.9 }),
        raw({ summary: 'over', confidence: 5 }), // clamps to 1 → sorts first
        raw({ summary: 'mid', confidence: 0.5 }),
      ],
    });
    expect(result.suggestions.map((s) => s.summary)).toEqual(['over', 'high', 'mid', 'low']);
  });

  test('missing evidence defaults to []; provided evidence passes through', async () => {
    const result = await runSuggest(detectEngine(), {
      suggestFn: async () => [
        raw({ summary: 'bare', confidence: 0.8 }),
        raw({ summary: 'with', confidence: 0.4, evidence: ['a-slug', 'b-slug'] }),
      ],
    });
    expect(result.suggestions.find((s) => s.summary === 'bare')!.evidence).toEqual([]);
    expect(result.suggestions.find((s) => s.summary === 'with')!.evidence).toEqual(['a-slug', 'b-slug']);
  });
});

describe('runSuggest — seam plumbing', () => {
  test('suggestFn receives the detect result + capped sampleSize; source_id flows through', async () => {
    let seen: SuggestPromptInput | undefined;
    const result = await runSuggest(
      detectEngine({ total: 12, untyped: 5, typed: 7 }),
      {
        sourceId: 'wiki',
        maxSampleSize: 200,
        suggestFn: async (input) => {
          seen = input;
          return [];
        },
      },
    );
    expect(result.source_id).toBe('wiki');
    expect(seen?.detected.total_pages).toBe(12);
    expect(seen?.sampleSize).toBe(12); // min(maxSampleSize=200, total_pages=12)
    // Untyped pages with zero suggestions → the review-candidates pointer note.
    expect(result.suggestions).toEqual([]);
    expect(result.notes.some((n) => n.includes('review-candidates'))).toBe(true);
  });
});

describe('runSuggest — heuristic fallback (no suggestFn)', () => {
  test('emits one add_type per detected prefix at confidence EXACTLY 0.5 — strictly below the 0.6 auto-apply floor', async () => {
    const result = await runSuggest(
      detectEngine({
        total: 12,
        untyped: 5,
        typed: 7,
        prefixes: [{ prefix: 'projects/', cnt: '7', sample_types: ['note', 'memo', 'idea', 'extra'] }],
      }),
    );
    expect(result.suggestions).toHaveLength(1);
    const s = result.suggestions[0]!;
    expect(s.kind).toBe('add_type');
    expect(s.summary).toBe('Add type `projects` for 7 pages under `projects/`');
    // THE load-bearing pair: exactly 0.5, and strictly below the auto-apply floor.
    expect(s.confidence).toBe(0.5);
    expect(s.confidence).toBeLessThan(0.6);
    // Evidence = the prefix's sample types, capped at 3.
    expect(s.evidence).toEqual(['note', 'memo', 'idea']);
    // Every no-LLM branch announces itself as heuristic.
    expect(result.notes.some((n) => /heuristic/i.test(n))).toBe(true);
  });
});

describe('runSuggest — source-text contract (structural)', () => {
  test('the 0.5 heuristic constant and the documented 0.6 floor stay in suggest.ts together', () => {
    // The 0.6 auto-apply floor has no exported constant — it is a documented
    // contract (suggest.ts, skills/eiirp/SKILL.md, eval-schema-authoring's
    // low_confidence_count). Pin both literals in the one file that carries
    // the safe-by-construction pairing, so a change to either side must
    // reconcile this test (and thus the other side) explicitly.
    const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'core', 'schema-pack', 'suggest.ts'), 'utf-8');
    expect(src).toMatch(/confidence:\s*0\.5/);
    expect(src).toMatch(/confidence\s*<\s*0\.6/);
  });
});
