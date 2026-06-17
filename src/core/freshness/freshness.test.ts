import { describe, test, expect } from 'bun:test';
import { computeFreshness, getDecayClassForType, getSourcePrecision, getDefaultStaleDays } from './freshness.ts';

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('getDecayClassForType', () => {
  test('decision type → slow decay (365 days)', () => {
    expect(getDecayClassForType('decision')).toBe('slow');
  });

  test('meeting type → medium decay (90 days)', () => {
    expect(getDecayClassForType('meeting')).toBe('medium');
  });

  test('status type → fast decay (30 days)', () => {
    expect(getDecayClassForType('status')).toBe('fast');
  });

  test('deal type → fast decay (30 days)', () => {
    expect(getDecayClassForType('deal')).toBe('fast');
  });

  test('unknown type → medium decay default', () => {
    expect(getDecayClassForType('concept')).toBe('medium');
    expect(getDecayClassForType('person')).toBe('medium');
    expect(getDecayClassForType('')).toBe('medium');
  });
});

describe('getSourcePrecision', () => {
  test('voice source → low precision, 0.6 confidence', () => {
    const result = getSourcePrecision('voice');
    expect(result.source_precision).toBe('low');
    expect(result.confidence).toBe(0.6);
  });

  test('meeting source → low precision, 0.6 confidence', () => {
    const result = getSourcePrecision('meeting');
    expect(result.source_precision).toBe('low');
    expect(result.confidence).toBe(0.6);
  });

  test('document source → medium precision, 0.8 confidence', () => {
    const result = getSourcePrecision('document');
    expect(result.source_precision).toBe('medium');
    expect(result.confidence).toBe(0.8);
  });

  test('email source → medium precision, 0.8 confidence', () => {
    const result = getSourcePrecision('email');
    expect(result.source_precision).toBe('medium');
    expect(result.confidence).toBe(0.8);
  });

  test('linkedin source → high precision, 0.9 confidence', () => {
    const result = getSourcePrecision('linkedin');
    expect(result.source_precision).toBe('high');
    expect(result.confidence).toBe(0.9);
  });

  test('manual source → high precision, 0.9 confidence', () => {
    const result = getSourcePrecision('manual');
    expect(result.source_precision).toBe('high');
    expect(result.confidence).toBe(0.9);
  });

  test('unknown source → medium precision default, 0.8 confidence', () => {
    const result = getSourcePrecision('slack');
    expect(result.source_precision).toBe('medium');
    expect(result.confidence).toBe(0.8);
  });
});

describe('computeFreshness', () => {
  test('fresh page (< half stale period) → fresh', () => {
    const result = computeFreshness({
      last_verified_at: daysAgo(10),
      decay_class: 'slow',
      source_precision: 'high',
      confidence: 0.9,
      stale_after_days: 365,
    });
    expect(result.status).toBe('fresh');
  });

  test('aging page (halfway through) → aging', () => {
    const result = computeFreshness({
      last_verified_at: daysAgo(200),
      decay_class: 'slow',
      source_precision: 'high',
      confidence: 0.9,
      stale_after_days: 365,
    });
    expect(result.status).toBe('aging');
  });

  test('stale page (past stale_after_days) → stale', () => {
    const result = computeFreshness({
      last_verified_at: daysAgo(400),
      decay_class: 'slow',
      source_precision: 'high',
      confidence: 0.9,
      stale_after_days: 365,
    });
    expect(result.status).toBe('stale');
  });

  test('fresh status returns correct days_since_verified', () => {
    const result = computeFreshness({
      last_verified_at: daysAgo(5),
      decay_class: 'fast',
      source_precision: 'high',
      confidence: 0.9,
      stale_after_days: 30,
    });
    expect(result.status).toBe('fresh');
    expect(result.days_since_verified).toBeGreaterThan(0);
    expect(result.days_since_verified).toBeLessThan(6);
  });

  test('aging status returns correct days_since_verified', () => {
    const result = computeFreshness({
      last_verified_at: daysAgo(20),
      decay_class: 'fast',
      source_precision: 'high',
      confidence: 0.9,
      stale_after_days: 30,
    });
    expect(result.status).toBe('aging');
    expect(result.days_since_verified).toBeGreaterThan(15);
    expect(result.days_since_verified).toBeLessThan(21);
  });
});

describe('getDefaultStaleDays', () => {
  test('maps slow/medium/fast', () => {
    expect(getDefaultStaleDays('slow')).toBe(365);
    expect(getDefaultStaleDays('medium')).toBe(90);
    expect(getDefaultStaleDays('fast')).toBe(30);
  });
});

describe('computeFreshness validation', () => {
  test('invalid last_verified_at throws', () => {
    expect(() => computeFreshness({
      last_verified_at: 'not-a-date',
      decay_class: 'slow',
      source_precision: 'high',
      confidence: 0.9,
      stale_after_days: 365,
    })).toThrow('Invalid');
  });

  test('empty last_verified_at throws', () => {
    expect(() => computeFreshness({
      last_verified_at: '',
      decay_class: 'slow',
      source_precision: 'high',
      confidence: 0.9,
      stale_after_days: 365,
    })).toThrow('Invalid');
  });
});
