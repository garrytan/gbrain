/**
 * v0.31 Phase 6 — facts decay helper unit tests.
 *
 * Pins the per-kind halflife table values so future tweaks are intentional,
 * not accidental. Pure-function tests; no DB.
 */

import { describe, test, expect } from 'bun:test';
import { effectiveConfidence, HALFLIFE_DAYS } from '../src/core/facts/decay.ts';
import type { FactRow, FactKind } from '../src/core/engine.ts';

function makeFact(overrides: Partial<FactRow> = {}): FactRow {
  return {
    id: 1, source_id: 'default', entity_slug: null, fact: 'x', kind: 'fact',
    visibility: 'private', notability: 'medium', context: null,
    valid_from: new Date(), valid_until: null, expired_at: null,
    superseded_by: null, consolidated_at: null, consolidated_into: null,
    source: 'test', source_session: null, confidence: 1.0,
    embedding: null, embedded_at: null, created_at: new Date(),
    ...overrides,
  };
}

const NOW = new Date('2026-05-01T00:00:00Z');
const MS_PER_DAY = 86_400_000;

describe('HALFLIFE_DAYS table', () => {
  test('every FactKind has a halflife', () => {
    const kinds: FactKind[] = ['event', 'preference', 'commitment', 'belief', 'fact'];
    for (const k of kinds) {
      expect(HALFLIFE_DAYS[k]).toBeDefined();
      expect(HALFLIFE_DAYS[k]).toBeGreaterThan(0);
    }
  });

  test('halflife values match the v0.31 plan', () => {
    expect(HALFLIFE_DAYS.event).toBe(7);
    expect(HALFLIFE_DAYS.commitment).toBe(90);
    expect(HALFLIFE_DAYS.preference).toBe(90);
    expect(HALFLIFE_DAYS.belief).toBe(365);
    expect(HALFLIFE_DAYS.fact).toBe(365);
  });
});

describe('effectiveConfidence', () => {
  test('age 0 returns input confidence', () => {
    const f = makeFact({ kind: 'event', valid_from: NOW, confidence: 1.0 });
    expect(effectiveConfidence(f, NOW)).toBeCloseTo(1.0, 6);
  });

  test('age = halflife returns ~0.368 (1/e)', () => {
    const f = makeFact({
      kind: 'event',
      valid_from: new Date(NOW.getTime() - 7 * MS_PER_DAY),
      confidence: 1.0,
    });
    const expected = Math.exp(-1); // ~0.3679
    expect(effectiveConfidence(f, NOW)).toBeCloseTo(expected, 4);
  });

  test('age = 2× halflife returns ~0.135 (1/e²)', () => {
    const f = makeFact({
      kind: 'event',
      valid_from: new Date(NOW.getTime() - 14 * MS_PER_DAY),
      confidence: 1.0,
    });
    const expected = Math.exp(-2);
    expect(effectiveConfidence(f, NOW)).toBeCloseTo(expected, 4);
  });

  test('expired fact returns 0', () => {
    const f = makeFact({
      kind: 'fact',
      valid_from: NOW,
      expired_at: new Date(NOW.getTime() - 1000),
      confidence: 1.0,
    });
    expect(effectiveConfidence(f, NOW)).toBe(0);
  });

  test('valid_until in the past returns 0', () => {
    const f = makeFact({
      kind: 'event',
      valid_from: NOW,
      valid_until: new Date(NOW.getTime() - 1000),
      confidence: 1.0,
    });
    expect(effectiveConfidence(f, NOW)).toBe(0);
  });

  test('valid_until in the future does NOT zero the value', () => {
    const f = makeFact({
      kind: 'event',
      valid_from: NOW,
      valid_until: new Date(NOW.getTime() + 1000 * 60 * 60),
      confidence: 1.0,
    });
    expect(effectiveConfidence(f, NOW)).toBeCloseTo(1.0, 6);
  });

  test('preference decays slower than event for same age', () => {
    const ageMs = 30 * MS_PER_DAY;
    const event = makeFact({ kind: 'event', valid_from: new Date(NOW.getTime() - ageMs), confidence: 1.0 });
    const pref = makeFact({ kind: 'preference', valid_from: new Date(NOW.getTime() - ageMs), confidence: 1.0 });
    expect(effectiveConfidence(pref, NOW)).toBeGreaterThan(effectiveConfidence(event, NOW));
  });

  test('result is clamped to [0, 1]', () => {
    const veryOld = makeFact({
      kind: 'event',
      valid_from: new Date(0),
      confidence: 0.5,
    });
    const result = effectiveConfidence(veryOld, NOW);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  test('confidence 0.0 stays 0', () => {
    const f = makeFact({ kind: 'fact', valid_from: NOW, confidence: 0.0 });
    expect(effectiveConfidence(f, NOW)).toBe(0);
  });

  test('valid_from in the future returns clamped input confidence', () => {
    const f = makeFact({
      kind: 'event',
      valid_from: new Date(NOW.getTime() + 1000 * 60),
      confidence: 0.7,
    });
    expect(effectiveConfidence(f, NOW)).toBeCloseTo(0.7, 6);
  });

  test('belief decays slower than commitment for same age (different halflives)', () => {
    const age = 200 * MS_PER_DAY;
    const belief = makeFact({ kind: 'belief', valid_from: new Date(NOW.getTime() - age), confidence: 1.0 });
    const commitment = makeFact({ kind: 'commitment', valid_from: new Date(NOW.getTime() - age), confidence: 1.0 });
    expect(effectiveConfidence(belief, NOW)).toBeGreaterThan(effectiveConfidence(commitment, NOW));
  });
});
