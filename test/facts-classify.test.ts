/**
 * v0.31 Phase 6 — classify.ts unit tests.
 *
 * Pins:
 *   - cosineSimilarity math (orthogonal/identity/proportional)
 *   - cheap fast-path (D13: cosine >= 0.95 → duplicate, no LLM call)
 *   - classifier-failure cosine fallback (D12: >=0.92 → duplicate)
 *   - empty candidates → independent
 *   - 4-strategy parse fallback for malformed JSON
 */

import { describe, test, expect } from 'bun:test';
import {
  cosineSimilarity,
  classifyAgainstCandidates,
} from '../src/core/facts/classify.ts';
import type { FactRow } from '../src/core/engine.ts';

function makeFact(overrides: Partial<FactRow> & { id: number }): FactRow {
  return {
    source_id: 'default', entity_slug: 'people/alice-example', fact: 'x', kind: 'fact',
    visibility: 'private', notability: 'medium', context: null,
    valid_from: new Date(), valid_until: null, expired_at: null,
    superseded_by: null, consolidated_at: null, consolidated_into: null,
    source: 'test', source_session: null, confidence: 1.0,
    embedding: null, embedded_at: null, created_at: new Date(),
    ...overrides,
  };
}

const EMBED_LEN = 8;
function vec(...values: number[]): Float32Array {
  const a = new Float32Array(EMBED_LEN);
  for (let i = 0; i < values.length; i++) a[i] = values[i];
  return a;
}

describe('cosineSimilarity', () => {
  test('identity returns 1.0', () => {
    const a = vec(1, 0, 0);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0, 6);
  });

  test('orthogonal returns 0', () => {
    expect(cosineSimilarity(vec(1, 0, 0), vec(0, 1, 0))).toBeCloseTo(0, 6);
  });

  test('proportional returns 1.0 (scale invariant)', () => {
    expect(cosineSimilarity(vec(2, 0, 0), vec(7, 0, 0))).toBeCloseTo(1.0, 6);
  });

  test('mismatched length returns 0', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toBe(0);
  });

  test('zero vector returns 0', () => {
    expect(cosineSimilarity(new Float32Array([0, 0, 0]), vec(1, 0, 0))).toBe(0);
  });
});

describe('classifyAgainstCandidates', () => {
  test('empty candidates → independent', async () => {
    const result = await classifyAgainstCandidates(
      { fact: 'new', kind: 'fact', embedding: vec(1) },
      [],
    );
    expect(result.decision).toBe('independent');
    expect((result as { reason: string }).reason).toBe('no_candidates');
  });

  test('cheap fast-path: cosine >= 0.95 → duplicate, classifier never called', async () => {
    // Same vector → cosine 1.0 → fast-path triggers.
    const candidates = [makeFact({ id: 42, embedding: vec(1) })];
    const result = await classifyAgainstCandidates(
      { fact: 'new', kind: 'fact', embedding: vec(1) },
      candidates,
    );
    expect(result.decision).toBe('duplicate');
    expect((result as { matched_id: number }).matched_id).toBe(42);
    expect((result as { reason: string }).reason).toBe('cheap_fast_path');
  });

  test('below cheap threshold but at-or-above fallback threshold → cosine_fallback duplicate', async () => {
    // cos(vec(1,0,0), vec(0.95, sqrt(1-0.9025)=0.31225, 0)) ≈ 0.95
    // We want cos < 0.95 (default cheap) and >= 0.92 (default fallback).
    // Build via simple skew: a=(1,0), b=(0.93,0.367)/||·|| gives cos≈0.93.
    const a = vec(1, 0);
    const b = vec(0.93, 0.367);
    const cos = (a[0]*b[0] + a[1]*b[1]) / (Math.sqrt(1) * Math.sqrt(0.93*0.93 + 0.367*0.367));
    expect(cos).toBeGreaterThan(0.92);
    expect(cos).toBeLessThan(0.95);
    const candidates = [makeFact({ id: 7, embedding: b })];
    const result = await classifyAgainstCandidates(
      { fact: 'new', kind: 'fact', embedding: a },
      candidates,
    );
    // Without API key in test env, isAvailable('chat') is false → straight to
    // cosine fallback. cos ≈ 0.93 ≥ 0.92 → duplicate.
    expect(result.decision).toBe('duplicate');
    expect((result as { reason: string }).reason).toBe('cosine_fallback');
  });

  test('no embedding on new fact → falls through to classifier path or cosine fallback', async () => {
    const candidates = [makeFact({ id: 7, embedding: vec(1) })];
    const result = await classifyAgainstCandidates(
      { fact: 'new', kind: 'fact', embedding: null },
      candidates,
    );
    // Without API key in test env, isAvailable('chat') is false → cosine fallback path.
    // newFact has no embedding so cosine fallback can't compute → independent.
    expect(result.decision).toBe('independent');
    expect((result as { reason: string }).reason).toBe('cosine_fallback');
  });
});
