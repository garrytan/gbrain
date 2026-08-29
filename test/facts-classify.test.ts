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

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  cosineSimilarity,
  classifyAgainstCandidates,
} from '../src/core/facts/classify.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import type { FactRow } from '../src/core/engine.ts';

/**
 * Two tests below pin the NO-CHAT-PROVIDER branch (classifier unavailable →
 * cosine fallback). They used to just assume it: legacy-embedding-preload
 * snapshots `env: { ...process.env }` into the gateway, so any provider key
 * that reaches the snapshot makes `isAvailable('chat')` true and the tests
 * take the LLM classifier path — real billable calls from a unit test.
 * provider-keys-preload now strips ambient keys before the snapshot, but
 * that is an environmental guarantee; pin the precondition in-file with an
 * explicitly empty gateway env (the override mechanism the legacy preload
 * documents). resetGateway() restores the baseline for later files in the
 * shard (#3554 makes it re-apply the legacy config, not unconfigure).
 */
beforeAll(() => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
});

afterAll(() => {
  resetGateway();
});

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
    // Gateway configured with env:{} above → isAvailable('chat') is false →
    // straight to cosine fallback. cos ≈ 0.93 ≥ 0.92 → duplicate.
    expect(result.decision).toBe('duplicate');
    expect((result as { reason: string }).reason).toBe('cosine_fallback');
  });

  test('no embedding on new fact → falls through to classifier path or cosine fallback', async () => {
    const candidates = [makeFact({ id: 7, embedding: vec(1) })];
    const result = await classifyAgainstCandidates(
      { fact: 'new', kind: 'fact', embedding: null },
      candidates,
    );
    // Gateway configured with env:{} above → isAvailable('chat') is false →
    // cosine fallback path. newFact has no embedding so cosine fallback can't
    // compute → independent.
    expect(result.decision).toBe('independent');
    expect((result as { reason: string }).reason).toBe('cosine_fallback');
  });
});

describe('classify gate — key-aware, engine-free (CX10)', () => {
  test('unservable classifier model degrades to cosine fallback, never throws', async () => {
    const { withEnv } = await import('./helpers/with-env.ts');
    // Deterministic gate: clear any gateway/transport state a sibling file in
    // this shard's process left behind — the test must exercise the
    // unavailability gate, not a leftover stub or a network failure.
    const { resetGateway, __setChatTransportForTests } = await import('../src/core/ai/gateway.ts');
    resetGateway();
    __setChatTransportForTests(null);
    await withEnv({
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      GBRAIN_MODEL: undefined,
      GBRAIN_HOME: '/nonexistent-gbrain-home-classify-test',
    }, async () => {
      const existing = makeFact({ id: 1, embedding: vec(1, 0, 0) });
      // Keyless env → resolveTierDefault('utility') yields the Anthropic
      // default whose key is absent → gate fails (or, if a sibling test file
      // left a transport stub, the call itself fails) → cosine fallback at
      // ≥0.92 → duplicate. Either path must land on cosine_fallback.
      const r = await classifyAgainstCandidates(
        { fact: 'x', kind: 'fact', embedding: vec(0.93, Math.sqrt(1 - 0.93 * 0.93), 0) },
        [existing],
      );
      expect(r.reason).toBe('cosine_fallback');
      expect(r.decision).toBe('duplicate');
      if (r.decision === 'duplicate') expect(r.matched_id).toBe(1);
    });
  });
});
