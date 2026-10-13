/**
 * W3 — `search.reranker.gate` and `search.reranker.gate_min_gap` as search
 * knobs, plus the `--explain` line.
 *
 * Protects: the per-call → config → bundle ladder for the gate, the config
 * parse of both keys, every bundle defaulting to `off`, the cache key
 * changing with the gate, δ and the evidence cosine floor (so a row written
 * under one gate setting can never serve another), and the explain summary
 * staying absent when the gate is off.
 * Fails when: a knob is dropped from resolveSearchMode or knobsHash, a bad
 * config value leaks through instead of falling back, or explain output
 * changes for gate-off searches.
 * Seams: none (pure).
 */
import { describe, expect, test } from 'bun:test';
import {
  KNOB_CONFIG_KEY,
  MODE_BUNDLES,
  knobsHash,
  loadOverridesFromConfig,
  resolveSearchMode,
} from '../../src/core/search/mode.ts';
import { formatRerankGateSummary, formatResultsExplain } from '../../src/core/search/explain-formatter.ts';
import type { SearchResult } from '../../src/core/types.ts';

describe('rerank gate knobs', () => {
  test('every bundle ships the gate off with δ 0.05', () => {
    for (const bundle of Object.values(MODE_BUNDLES)) {
      expect(bundle.reranker_gate).toBe('off');
      expect(bundle.reranker_gate_min_gap).toBe(0.05);
    }
    expect(KNOB_CONFIG_KEY.reranker_gate).toBe('search.reranker.gate');
    expect(KNOB_CONFIG_KEY.reranker_gate_min_gap).toBe('search.reranker.gate_min_gap');
  });

  test('config parse: recognized values set the override, anything else falls through', () => {
    expect(loadOverridesFromConfig({ 'search.reranker.gate': 'SHADOW' }).reranker_gate).toBe('shadow');
    expect(loadOverridesFromConfig({ 'search.reranker.gate': 'maybe' }).reranker_gate).toBeUndefined();
    expect(loadOverridesFromConfig({ 'search.reranker.gate_min_gap': '0' }).reranker_gate_min_gap).toBe(0);
    expect(loadOverridesFromConfig({ 'search.reranker.gate_min_gap': '2' }).reranker_gate_min_gap).toBeUndefined();
  });

  test('per-call beats config beats bundle', () => {
    expect(resolveSearchMode({ mode: 'balanced' }).reranker_gate).toBe('off');
    expect(resolveSearchMode({ mode: 'balanced', overrides: { reranker_gate: 'shadow' } }).reranker_gate).toBe('shadow');
    expect(resolveSearchMode({ mode: 'balanced', overrides: { reranker_gate: 'shadow' }, perCall: { reranker_gate: 'off' } }).reranker_gate).toBe('off');
    expect(resolveSearchMode({ mode: 'tokenmax', overrides: { reranker_gate_min_gap: 0 } }).reranker_gate_min_gap).toBe(0);
  });

  test('knobsHash changes with the gate, δ and the floor; explicit defaults hash as the default', () => {
    const base = knobsHash(resolveSearchMode({ mode: 'balanced' }));
    const shadow = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { reranker_gate: 'shadow' } }));
    const gap = knobsHash(resolveSearchMode({ mode: 'balanced', overrides: { reranker_gate_min_gap: 0 } }));
    const floor = knobsHash(resolveSearchMode({ mode: 'balanced', overrides: { evidence_cosine_floor: 0.75 } }));
    expect(new Set([base, shadow, gap, floor]).size).toBe(4);
    expect(knobsHash(resolveSearchMode({ mode: 'balanced', overrides: { reranker_gate: 'off', reranker_gate_min_gap: 0.05, evidence_cosine_floor: 0.8 } }))).toBe(base);
  });
});

describe('rerank gate --explain line', () => {
  const rows = [{ slug: 'notes/a', score: 1, chunk_text: 'a', title: 'a' } as SearchResult];
  test('absent when the gate is off', () => {
    expect(formatRerankGateSummary(undefined)).toBeNull();
    expect(formatResultsExplain(rows, { vector_enabled: true, detail_resolved: null, expansion_applied: false })).not.toContain('rerank gate');
  });
  test('names the grade, the verdict and the signal', () => {
    expect(formatRerankGateSummary({ mode: 'shadow', eligible: true, grade: 'strong', reason: 'high_vector_match', top_cosine: 0.91, gap: 0.12, candidates: 9, would_skip: true, provider_called: true }))
      .toBe('rerank gate (shadow): strong high_vector_match — would skip (cosine 0.91, gap 0.12, 9 candidates)');
    expect(formatRerankGateSummary({ mode: 'shadow', eligible: true, grade: 'strong', reason: 'alias_hit', candidates: 3, would_skip: false, skip_blocked: 'shadow_only_reason', provider_called: true }))
      .toBe('rerank gate (shadow): strong alias_hit — would rerank (shadow_only_reason) (3 candidates)');
    expect(formatRerankGateSummary({ mode: 'shadow', eligible: false, ineligible_reason: 'egress_denied', candidates: 3, would_skip: false, provider_called: false }))
      .toBe('rerank gate (shadow): not graded (egress_denied)');
  });
});
